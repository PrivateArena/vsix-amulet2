import * as path from 'node:path';

/**
 * Path maths for `@`-mention listings, kept free of `vscode` so it stays testable
 * (the same split `tool-image.ts` uses: the bridge owns postMessage, this owns paths).
 */

/** Separator the webview matches and inserts with, whatever the host OS is. */
export const POSIX_SEP = '/';

/**
 * Absolute paths -> project-relative POSIX paths, de-duplicated, shallowest first.
 *
 * Relative and in POSIX form because that is what the model is told to resolve: the
 * runtime's own cwd is the base, and pi reads paths with forward slashes on every
 * platform. Anything outside `cwd` is dropped — a completion must never offer a path
 * the agent cannot reach from where it works, and an escaping path is a leak of the
 * user's directory layout into a prompt they did not mean to write.
 *
 * Shallow-first ordering is what lets the caller cap the list without losing the top of
 * the tree, and it compares with plain `<` so two hosts really do order it identically.
 */
export function toProjectPaths(
  absolutePaths: Iterable<string>,
  cwd: string,
): string[] {
  const base = path.resolve(cwd);
  const seen = new Set<string>();
  for (const abs of absolutePaths) {
    const rel = path.relative(base, path.resolve(abs));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)) continue;
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length === 0) continue;
    seen.add(parts.join(POSIX_SEP));
  }
  return [...seen].sort(compareDepthFirst);
}

function compareDepthFirst(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length;
  if (depth) return depth;
  return a < b ? -1 : a > b ? 1 : 0;
}
