import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandInfo, PromptResource } from '../../shared/protocol';
import {
  readTemplateFrontmatter,
  stripTemplateFrontmatter,
} from '../../shared/prompt-template';

/**
 * pi's prompt templates and skills live on disk, and the wire only names them.
 *
 * `get_commands` reports a `sourceInfo.path` for every file-backed command, and pi re-reads
 * that file at expansion time — so this module reads the same bytes rather than keeping a
 * second copy of anything. It is deliberately read-only: a template is the human's file,
 * and Amulet has no business writing one.
 */

/** Beyond this a "prompt" is a document, not a template — the dialog shows a prefix and says so. */
export const MAX_PROMPT_RESOURCE_BYTES = 512 * 1024;

export type PromptResourceResult =
  | { resource: PromptResource }
  | { error: string };

/** The folders a reported resource may live in. */
export interface PromptResourceRoots {
  /** pi's agent dir (`amulet.agentDir`), i.e. the user scope. */
  agentDir: string;
  /** The runtime's working directory, whose `.pi/` holds the project scope. */
  cwd: string;
}

/**
 * Read the file behind one `get_commands` row, or explain why the dialog cannot show it.
 * Every failure is a returned string: a missing or hostile file is a dialog message, not
 * an exception on the wire.
 */
export function readPromptResource(
  command: CommandInfo | undefined,
  roots: PromptResourceRoots,
): PromptResourceResult {
  if (!command) return { error: 'No such command in this runtime.' };
  const kind = command.source;
  if (kind !== 'prompt' && kind !== 'skill') {
    return {
      error:
        kind === 'extension'
          ? 'This is a pi extension command, not a prompt template: it runs code instead of expanding a file.'
          : 'This command is not backed by a prompt file.',
    };
  }
  const reported = command.sourceInfo?.path;
  if (!reported) return { error: 'pi reported no prompt file for this command.' };
  // `builtin:llama.cpp` and friends name nothing on disk.
  if (!path.isAbsolute(reported)) {
    return { error: `pi reported no readable prompt file for this command (${reported}).` };
  }
  if (!reported.toLowerCase().endsWith('.md')) {
    return { error: `Not a markdown prompt file: ${reported}` };
  }

  const file = path.resolve(reported);
  // A symlinked agent dir is common (`~/.pi` living on another volume) and pi reports whichever
  // spelling it walked to, so containment is decided against every spelling of both sides.
  const spellings = [file, realpathOf(file) ?? file].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  const inside = allowedRoots(command, roots);
  if (!spellings.some((p) => inside.some((root) => isUnder(p, root)))) {
    return {
      error: `Refusing to read ${file}: it is outside pi's prompt folders (${inside.join(', ')}).`,
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return {
      error: `The prompt file pi reported is not there: ${file}. It was moved or deleted after this runtime started.`,
    };
  }
  if (!stats.isFile()) return { error: `Not a file: ${file}` };
  if (stats.size > MAX_PROMPT_RESOURCE_BYTES) {
    return {
      error: `That prompt file is ${(stats.size / 1024).toFixed(0)} KB, over the ${MAX_PROMPT_RESOURCE_BYTES / 1024} KB read budget.`,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const hint = readTemplateFrontmatter(raw, 'argument-hint');
  const baseDir = command.sourceInfo?.baseDir;
  return {
    resource: {
      name: command.name,
      kind,
      path: file,
      // pi's skill block names the directory its relative references resolve against;
      // a skill is a folder with a SKILL.md in it, so its own directory is the fallback.
      ...(kind === 'skill' ? { baseDir: baseDir ?? path.dirname(file) } : {}),
      ...(hint ? { hint } : {}),
      body: stripTemplateFrontmatter(raw),
    },
  };
}

/**
 * The folders this row may legitimately point into: the base dir pi reported, then the
 * user and project scopes. A `baseDir` is a directory by construction, and each root counts in
 * both its written and its symlink-resolved spelling.
 */
function allowedRoots(command: CommandInfo, roots: PromptResourceRoots): string[] {
  const list = [
    command.sourceInfo?.baseDir,
    roots.agentDir,
    path.join(roots.agentDir, 'prompts'),
    path.join(roots.agentDir, 'skills'),
    path.join(roots.cwd, '.pi', 'prompts'),
    path.join(roots.cwd, '.pi', 'skills'),
    path.join(roots.cwd, '.agents', 'skills'),
  ];
  const out = list
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .flatMap((p) => {
      const resolved = path.resolve(p);
      const real = realpathOf(resolved);
      return real && real !== resolved ? [resolved, real] : [resolved];
    });
  // `.agents/skills` is also reachable through the ancestors of the cwd (`package-manager.js:290-306`),
  // so accept any `.agents/skills` ancestor segment the reported base dir sits in.
  const base = command.sourceInfo?.baseDir;
  if (base && /[\\/]\.agents[\\/]/.test(base)) out.push(realpathOr(path.dirname(base)));
  return out.length > 0 ? out : [realpathOr(roots.agentDir)];
}

/** Resolve symlinks for an existing path, or the nearest existing ancestor of it. */
function realpathOf(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? null : realpathOf(parent);
  }
}

function realpathOr(target: string): string {
  const resolved = path.resolve(target);
  return realpathOf(resolved) ?? resolved;
}

/** Containment on resolved paths, separator-aware (`isUnderPath`, `prompt-templates.js:193-201`). */
function isUnder(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}
