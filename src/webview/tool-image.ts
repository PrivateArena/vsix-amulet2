/**
 * Serving the images a tool returned to a webview that no longer carries their bytes.
 *
 * The host strips every base64 payload before forwarding a tool result (see
 * `stripImagePayloads` in `shared/blocks.ts`), so a card that wants pixels asks for one
 * by the path its own call named. Nothing here imports `vscode`: the bridge owns the
 * postMessage side, this file owns the filesystem, and the rules stay testable in the
 * plain-node suite.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Ceiling for one image handed to a webview. A data URL costs about 4/3 of the file and
 * lives in the renderer's heap, so the cap is a memory budget, not a correctness one —
 * a larger file reports its size instead of hanging the panel.
 */
export const MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024;

/** Longest signature to read before deciding a file is not an image. */
const SIGNATURE_BYTES = 16;

/** A tool image the host could read, with the data URL ready for `<img src>`. */
export interface ToolImageSuccess {
  ok: true;
  /** Absolute path of the file that was read. */
  filePath: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

/** Why a tool image could not be served, worded for the card that asked. */
export interface ToolImageFailure {
  ok: false;
  /** Absolute path when the request resolved to one (so the message can name it). */
  filePath?: string;
  error: string;
}

/** Either outcome of {@link readToolImage}. */
export type ToolImageResult = ToolImageSuccess | ToolImageFailure;

/** Decode a byte range as latin1 text, for header matching. */
function ascii(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, offset + length).toString('latin1');
}

/**
 * The image types pi's `read` tool can return, by their file signature.
 *
 * Identified by content rather than by name because the name is the model's: a symlink
 * or a renamed key file must not be able to make the extension host hand its contents to
 * a webview as a picture.
 */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < SIGNATURE_BYTES) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const head = ascii(bytes, 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  // RIFF....WEBPVP8 / VP8L / VP8X — the codec chunk follows the container name.
  if (
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP' &&
    ascii(bytes, 12, 3) === 'VP8'
  ) {
    return 'image/webp';
  }
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  return null;
}

/** Read the head of a file, or null when it cannot be opened. */
async function readSignature(filePath: string): Promise<Buffer | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SIGNATURE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Whether a path holds an image this webview could show. */
export async function isSupportedImage(filePath: string): Promise<boolean> {
  const header = await readSignature(filePath);
  return header !== null && sniffImageMime(header) !== null;
}

function tooLarge(size: number): string {
  return `image is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${(
    MAX_TOOL_IMAGE_BYTES /
    1024 /
    1024
  ).toFixed(0)} MB preview limit`;
}

/**
 * Where a tool call's path points, with `~` expanded and a relative path taken against
 * the runtime's working directory — the same base pi resolved the call itself against.
 * Says nothing about whether anything is there.
 */
function candidateOf(rawPath: string, cwd?: string): string {
  const expanded = expandHome(rawPath);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd ?? process.cwd(), expanded);
}

/** Expand a leading `~`, the one form of home-relative path an agent writes. */
function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Resolve the path a tool call named to a readable file, or null.
 */
export function resolveToolImagePath(
  rawPath: string,
  cwd?: string,
): string | null {
  const filePath = candidateOf(rawPath, cwd);
  try {
    if (!fs.statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return filePath;
}

/**
 * Read one tool image off disk, typed by what the file actually contains.
 */
export async function readToolImage(
  rawPath: string,
  options: { cwd?: string } = {},
): Promise<ToolImageResult> {
  const filePath = resolveToolImagePath(rawPath, options.cwd);
  if (!filePath) {
    // Named by where it looked, not by what the model typed: the call may have been
    // relative to a workspace the panel has since switched away from.
    return {
      ok: false,
      error: `no file at ${candidateOf(rawPath, options.cwd)}`,
    };
  }
  let bytes: Buffer;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_TOOL_IMAGE_BYTES) {
      return { ok: false, filePath, error: tooLarge(stat.size) };
    }
    bytes = await fs.promises.readFile(filePath);
    // The size may have moved between the two calls, and the check is a budget.
    if (bytes.length > MAX_TOOL_IMAGE_BYTES) {
      return { ok: false, filePath, error: tooLarge(bytes.length) };
    }
  } catch (err) {
    return {
      ok: false,
      filePath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) {
    return { ok: false, filePath, error: 'not a readable image file' };
  }
  return {
    ok: true,
    filePath,
    mimeType,
    size: bytes.length,
    dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
  };
}
