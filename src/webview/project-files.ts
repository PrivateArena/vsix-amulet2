import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ProjectFilesResult } from '../../shared/protocol';
import { toProjectPaths } from './project-paths';

/**
 * The file listing behind an `@`-mention.
 *
 * pi offers nothing here: its RPC surface has no file search, its `bash` command would
 * pollute the session context, and `docs/rpc.md` states outright that RPC mode rejects
 * `@file` prompt arguments. So VS Code's own search answers it, and a starting or crashed
 * runtime can still complete paths.
 */

/**
 * Cap on one listing, sized by the wire rather than by the tree: the whole list crosses
 * `postMessage` on every answer (~100 bytes per path), and a completion source past a few
 * thousand paths is unscrollable anyway. `truncated` says when the scan stopped early.
 */
const MAX_FILES = 5_000;

/**
 * How long a listing is reused. Typing `@` repeatedly must not rescan, while a file the
 * agent just wrote must become reachable again without an explicit reload — hence the
 * short window, plus the webview's forced retry when a search comes back empty.
 */
const CACHE_TTL_MS = 15_000;

interface Listing {
  paths: string[];
  truncated: boolean;
}

interface CacheEntry {
  /** When `paths` was captured. */
  at: number;
  paths: string[];
  truncated: boolean;
  scan?: Promise<Listing>;
  token?: vscode.CancellationTokenSource;
}

/** One listing per working directory — the pool can hold several runtimes. */
const cache = new Map<string, CacheEntry>();

/**
 * Project files for `cwd`, cached per directory. `force` ignores the cached listing, which
 * is what a "nothing matched, look again" retry needs; it still joins a crawl that is
 * already running rather than starting a second one.
 *
 * Rejects when `cwd` is not inside an open workspace folder: the runtime's fallback
 * working directory is the user's home, and walking that would either return nothing or
 * offer `~/.ssh` as chat completion — neither is what a "project file" means.
 */
export async function listProjectFiles(
  cwd: string,
  force = false,
): Promise<Omit<ProjectFilesResult, 'requestId' | 'cwd'>> {
  const key = path.resolve(cwd);
  const entry = cache.get(key);
  if (entry?.scan) return entry.scan;
  if (!force && entry && Date.now() - entry.at < CACHE_TTL_MS) {
    return { paths: entry.paths, truncated: entry.truncated };
  }
  if (!isInsideWorkspace(key)) {
    throw new Error(`"${key}" is not part of the open workspace`);
  }

  const target = entry ?? { at: 0, paths: [], truncated: false };
  // Whatever crawl this entry started is superseded now, so stop it before launching another.
  target.token?.dispose();
  const token = new vscode.CancellationTokenSource();
  const scan = run(target, key, token);
  target.token = token;
  target.scan = scan;
  cache.set(key, target);
  return scan;
}

async function run(
  entry: CacheEntry,
  key: string,
  token: vscode.CancellationTokenSource,
): Promise<Listing> {
  try {
    const listing = await scanProjectFiles(key, token.token);
    // Only the newest scan for this directory may publish; a superseded crawl that
    // finished late would otherwise stamp a stale tree as fresh for another TTL window.
    if (cache.get(key) === entry) {
      Object.assign(entry, listing, { at: Date.now(), scan: undefined });
    }
    return listing;
  } catch (err) {
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  } finally {
    token.dispose();
  }
}

async function scanProjectFiles(
  cwd: string,
  token: vscode.CancellationToken,
): Promise<Listing> {
  // A `RelativePattern` with a Uri base scopes the search to the runtime's directory even
  // when that folder is not itself a workspace folder. Asking for one over the cap is how
  // `truncated` is detected.
  const include = new vscode.RelativePattern(vscode.Uri.file(cwd), '**/*');
  const found = await vscode.workspace.findFiles(
    include,
    excludeGlob(cwd),
    MAX_FILES + 1,
    token,
  );
  const all = toProjectPaths(
    found.map((uri) => uri.fsPath),
    cwd,
  );
  const truncated = all.length > MAX_FILES;
  // Cut after sorting: the listing arrives shallow-first, so the survivors of the cap are
  // the project's own top levels rather than an alphabetical accident.
  return { paths: truncated ? all.slice(0, MAX_FILES) : all, truncated };
}

/**
 * Directories no completion ever needs: dependency trees, VCS metadata, build output.
 * They are left out of the listing entirely — omitting the `exclude` argument applies only
 * `files.exclude`, so a project's `node_modules` would be crawled and would win the whole
 * result cap before its own sources appear.
 */
const DEFAULT_EXCLUDES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'out',
  'build',
  'target',
  'vendor',
  'venv',
  '.venv',
  '.next',
  '__pycache__',
];

/**
 * One exclude glob covering every directory to skip. `findFiles` takes a single pattern, so
 * the list collapses into a brace group, and `search.exclude` is folded in so a project that
 * hides a generated tree from search hides it from completion too.
 */
function excludeGlob(cwd: string): string {
  const names = new Set(DEFAULT_EXCLUDES);
  const configured = vscode.workspace
    .getConfiguration('search', vscode.Uri.file(cwd))
    .get<Record<string, boolean>>('exclude');
  for (const [pattern, enabled] of Object.entries(configured ?? {})) {
    if (enabled === false) continue;
    const name = directoryName(pattern);
    if (name) names.add(name);
  }
  return `**/{${[...names].join(',')}}/**`;
}

/**
 * Directory a settings pattern names — a bare `node_modules`, or the same wrapped in a
 * recursive prefix and a trailing wildcard, all reduce to the one folder name. A pattern
 * that globs files rather than a directory (`*.code-search`, say) names no directory and is
 * left alone.
 */
function directoryName(pattern: string): string | undefined {
  const segments = pattern.split('/').filter((s) => s && s !== '**');
  const last = segments[segments.length - 1];
  if (!last || /[*?{}!]/.test(last)) return undefined;
  return /^[.A-Za-z0-9_-]+$/.test(last) ? last : undefined;
}

/** Whether `cwd` is the open workspace or something inside it. */
function isInsideWorkspace(cwd: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((folder) => {
    const base = path.resolve(folder.uri.fsPath);
    return cwd === base || cwd.startsWith(base + path.sep);
  });
}
