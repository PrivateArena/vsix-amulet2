/**
 * `@`-mentions — completing a project path inside the composer.
 *
 * The host lists the project's files (see `src/webview/project-files.ts`); everything that
 * decides *what to show* lives here, so it is testable and instant: the listing is already
 * in memory, so keystrokes never cross the bridge.
 *
 * Two deliberate limits. A mention ends at whitespace — which is how the slash menu behaves
 * too — so a path containing a space is inserted quoted, or pi would read half of it as
 * prose. And a leading `/` or `./` means the project root, because that is what people type
 * when they mean "from where the agent works".
 */

/** Kind of entry a completion offers. */
export type MentionKind = 'file' | 'dir';

/** One row of the file menu: a path plus the pieces needed to render it. */
export interface FileMention {
  /** Project-relative POSIX path; directories keep their trailing slash. */
  path: string;
  /** Last segment (`store.ts`, or `chat-bridge/` when navigating). */
  name: string;
  /** Parent directory, dimmed behind the name. */
  dir: string;
  kind: MentionKind;
}

/** Range of the in-progress `@token` inside the composer value. */
export interface AtTokenRange {
  start: number;
  end: number;
}

/** An `@token` at the end of the input, and the path typed inside it. */
export interface AtTokenMatch extends AtTokenRange {
  query: string;
}

/** How many rows the menu can show before it stops being scannable. */
export const FILE_MENTION_LIMIT = 40;

/**
 * The `@token` at the end of `value`, or null. The `@` must open a word, so e-mails,
 * decorators and paths already typed in prose do not summon the menu.
 */
export function parseAtToken(value: string): AtTokenMatch | null {
  const m = value.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const query = m[1];
  // The whitespace the regex matched is not part of the token.
  return { query, start: value.length - query.length - 1, end: value.length };
}

/** Lowercased, root-anchored query: `./src/` and `/src/` both mean `src/`. */
export function normalizeMentionQuery(query: string): string {
  return query.toLowerCase().replace(/^(\.\/|\/)+/, '');
}

/** Split a path into the pieces a row renders. */
export function toFileMention(path: string): FileMention {
  const cut = path.lastIndexOf('/');
  return {
    path,
    name: cut === -1 ? path : path.slice(cut + 1),
    dir: cut === -1 ? '' : path.slice(0, cut),
    kind: 'file',
  };
}

/** A directory row: the trailing slash is both the display and the insertion. */
function toDirMention(path: string): FileMention {
  const trimmed = path.replace(/\/$/, '');
  const cut = trimmed.lastIndexOf('/');
  return {
    path,
    name: `${cut === -1 ? trimmed : trimmed.slice(cut + 1)}/`,
    dir: cut === -1 ? '' : trimmed.slice(0, cut),
    kind: 'dir',
  };
}

/**
 * The draft text for a picked entry. A directory is left without a trailing space so the
 * caret stays on its slash and the user can keep descending; a file is complete, so it gets
 * one. Whitespace is quoted, because an unquoted `@my report.md` reaches pi as a path plus a
 * stray sentence — the mention token ends at the first space.
 */
export function mentionInsertion(mention: FileMention): string {
  const body = /\s/.test(mention.path) ? `'${mention.path}'` : mention.path;
  return `@${body}${mention.kind === 'file' ? ' ' : ''}`;
}

/**
 * Match score for one path against a query; -1 when it does not match.
 * Cheaper is better: a path typed from the root beats a bare name, which beats a substring,
 * which beats a hit somewhere in the directories above the file.
 */
function scorePath(path: string, query: string): number {
  if (path.startsWith(query)) return 0;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  return path.includes(query) ? 3 : -1;
}

/** Shallower first, then shorter, then alphabetical — the order a search wants to read. */
function byCloseness(a: FileMention, b: FileMention): number {
  const depth = a.path.split('/').length - b.path.split('/').length;
  if (depth) return depth;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path.localeCompare(b.path);
}

/** Alphabetical, because navigating a tree means looking for a letter, not a length. */
function byName(a: FileMention, b: FileMention): number {
  return a.path.localeCompare(b.path);
}

/** Directories get the bulk of the rows, but never all of them — see `takeTurns`. */
const DIR_SHARE = 0.6;

/**
 * Fill `limit` rows from two ordered groups, capping the first at `DIR_SHARE` of them, then
 * letting the leftovers have whatever is left. A directory-heavy folder must not hide the
 * files sitting next to it, and a flat one must not lose its subdirectories.
 */
function takeTurns(
  dirs: FileMention[],
  files: FileMention[],
  limit: number,
): FileMention[] {
  const dirCap = Math.max(1, Math.ceil(limit * DIR_SHARE));
  const head = dirs.slice(0, dirCap);
  return [...head, ...files, ...dirs.slice(dirCap)].slice(0, limit);
}

/**
 * Immediate children of the directory the query names — directories first, each with a
 * trailing slash so the user can keep descending. Used for `@` and for `@src/`.
 */
export function directoryEntries(
  paths: string[],
  query: string,
  limit = FILE_MENTION_LIMIT,
): FileMention[] {
  const dir = normalizeMentionQuery(query);
  const prefix = dir === '' || dir.endsWith('/') ? dir : `${dir}/`;
  const dirs = new Map<string, FileMention>();
  const files: FileMention[] = [];
  for (const candidate of paths) {
    if (!candidate.toLowerCase().startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(toFileMention(prefix + rest));
      continue;
    }
    const key = `${prefix}${rest.slice(0, slash)}/`;
    if (!dirs.has(key)) dirs.set(key, toDirMention(key));
  }
  return takeTurns([...dirs.values()].sort(byName), files.sort(byName), limit);
}

/** Every directory that appears above a listed file, as `a/b/` paths. */
function parentDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    let cut = path.lastIndexOf('/');
    while (cut > 0) {
      dirs.add(path.slice(0, cut + 1));
      cut = path.lastIndexOf('/', cut - 1);
    }
  }
  return [...dirs];
}

/**
 * The rows for the query being typed. A bare `@` or a trailing slash navigates; anything
 * else searches files *and* directories, so a half-typed folder name can still be completed
 * into instead of only matched through.
 */
export function rankFileMentions(
  paths: string[],
  query: string,
  limit = FILE_MENTION_LIMIT,
): FileMention[] {
  const q = normalizeMentionQuery(query);
  if (q === '' || q.endsWith('/')) return directoryEntries(paths, q, limit);
  const matches: FileMention[] = [];
  const dirs: FileMention[] = [];
  for (const candidate of paths) {
    if (scorePath(candidate.toLowerCase(), q) < 0) continue;
    matches.push(toFileMention(candidate));
  }
  for (const dir of parentDirs(paths)) {
    if (scorePath(dir.toLowerCase(), q) < 0) continue;
    dirs.push(toDirMention(dir));
  }
  // Scores are recomputed for the sort so a strong directory match can outrank a weak file.
  const scored = (list: FileMention[]) =>
    list
      .map((m) => ({ m, score: scorePath(m.path.toLowerCase(), q) }))
      .sort((a, b) => a.score - b.score || byCloseness(a.m, b.m))
      .map((e) => e.m);
  return takeTurns(scored(dirs), scored(matches), limit);
}
