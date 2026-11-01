import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_TOOL_IMAGE_BYTES,
  isSupportedImage,
  readToolImage,
  resolveToolImagePath,
  sniffImageMime,
} from './tool-image';

/**
 * The filesystem half of a tool image request. The card asks with the path its own call
 * named, so what matters here is that the same path resolves the way the runtime resolved
 * it — and that the file, not its name, decides what reaches the webview.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amulet-tool-image-'));

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(24, 7),
]);
const JPEG = Buffer.concat([
  Buffer.from('ffd8ffe0', 'hex'),
  Buffer.alloc(24, 7),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 7)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([40, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
  Buffer.alloc(16, 7),
]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(30, 7)]);

function write(name: string, bytes: Buffer): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

const shot = write('shot.png', PNG);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sniffImageMime', () => {
  it('names the types the read tool can return', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(BMP)).toBe('image/bmp');
  });

  it('refuses anything it cannot identify, including a short file', () => {
    expect(sniffImageMime(Buffer.from('#!/bin/sh\nrm -rf /\n'))).toBeNull();
    expect(sniffImageMime(Buffer.from('PK\u0003\u0004zipzip'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(4))).toBeNull();
  });
});

describe('resolveToolImagePath', () => {
  it('resolves a relative path against the runtime cwd', () => {
    const nested = path.join(dir, 'tmp');
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 'shot.png');
    fs.writeFileSync(file, PNG);
    expect(resolveToolImagePath('tmp/shot.png', dir)).toBe(file);
    expect(resolveToolImagePath(file)).toBe(file);
  });

  it('returns null for a missing path or a directory', () => {
    expect(resolveToolImagePath('nope.png', dir)).toBeNull();
    expect(resolveToolImagePath('.', dir)).toBeNull();
  });
});

describe('readToolImage', () => {
  it('reads an image by its path and hands back a data URL', async () => {
    expect(resolveToolImagePath(shot)).toBe(shot);
    const result = await readToolImage('shot.png', { cwd: dir });
    expect(result).toMatchObject({
      ok: true,
      mimeType: 'image/png',
      size: PNG.length,
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  it('types the file by its content, not by the name it was asked for', async () => {
    const renamed = write('report.pdf', PNG);
    const result = await readToolImage(renamed);
    expect(result).toMatchObject({ ok: true, mimeType: 'image/png' });
  });

  it('refuses a file that is not an image, however it is named', async () => {
    write('notes.png', Buffer.from('# not really an image\n'));
    const result = await readToolImage('notes.png', { cwd: dir });
    expect(result).toMatchObject({
      ok: false,
      error: 'not a readable image file',
    });
  });

  it('names the absolute path it looked for', async () => {
    const result = await readToolImage('gone.png', { cwd: dir });
    expect((result as { error: string }).error).toBe(
      `no file at ${path.join(dir, 'gone.png')}`,
    );
  });

  it('refuses a file over the preview budget, naming its size', async () => {
    const name = 'huge.png';
    fs.writeFileSync(
      path.join(dir, name),
      Buffer.concat([PNG, Buffer.alloc(MAX_TOOL_IMAGE_BYTES)]),
    );
    const result = await readToolImage(name, { cwd: dir });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('preview limit');
  });
});

describe('isSupportedImage', () => {
  it('agrees with the reader, on content alone', async () => {
    expect(await isSupportedImage(shot)).toBe(true);
    expect(
      await isSupportedImage(write('notes.txt', Buffer.from('hello'))),
    ).toBe(false);
    expect(await isSupportedImage(path.join(dir, 'missing.png'))).toBe(false);
  });
});
