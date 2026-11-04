import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  CompactionEntry,
  SessionEntryRef,
  SessionInfo,
} from '../../shared/protocol';
import { textOfContent } from '../../shared/blocks';
import { branchEntries } from '../../shared/session-entries';
import { resolveAgentDir } from '../runtime/bootstrap';

/**
 * Reads pi session files directly from disk to power the history browser.
 * Mirrors the pi runtime's own storage layout and metadata extraction:
 *   <agentDir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
 * where encoded-cwd = `--` + cwd (leading slash stripped, / \ : -> -) + `--`.
 */

/** Refuse to read a session file this big into memory (a runaway or corrupted log). */
const SESSION_READ_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * The same read, bounded by latency instead of memory: this runs on the extension host thread
 * while a snapshot is assembled, and a boundary card is not worth tens of ms per surface. Past
 * the cap the projection's own boundary is simply left standing.
 */
const COMPACTION_READ_LIMIT_BYTES = 16 * 1024 * 1024;

/** How far into an entry line to look for its `id`/`parentId`. */
const ENTRY_LINK_SCAN_BYTES = 512;

/** pi's own write order: `"id":"…","parentId":"…"|null`, in that order, side by side. */
const ENTRY_LINK_RE =
  /"id"\s*:\s*"([^"]+)"\s*,\s*"parentId"\s*:\s*(?:"([^"]+)"|null)/;

/** What a persisted compaction line starts with, in pi's own write order. */
const COMPACTION_LINE_RE = /^\{\s*"type"\s*:\s*"compaction"/;

/** One file's boundaries, remembered until the file itself changes. */
interface CachedBoundaries {
  mtimeMs: number;
  size: number;
  boundaries: CompactionEntry[];
}

/** Every surface of a session asks for the same boundaries; the map is LRU by read order. */
const boundaryCache = new Map<string, CachedBoundaries>();
const BOUNDARY_CACHE_SIZE = 8;

function agentDir(configuredAgentDir: string, cwd: string): string {
  // The same directory the runtime child is told to use (`buildSpawnEnv`), so the sessions the
  // history browser lists are the ones the runtime writes.
  return resolveAgentDir(configuredAgentDir, cwd);
}

function encodeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function sessionsDirForCwd(
  configuredAgentDir: string,
  cwd: string,
): string {
  return join(agentDir(configuredAgentDir, cwd), 'sessions', encodeCwd(cwd));
}

/**
 * The `id`/`parentId` of one entry line, without parsing the line.
 *
 * pi writes the pair adjacently, so matching it as one unit is what makes the scan safe on
 * entries whose payload can itself contain `"id":` (a `custom` entry's `data`) — and cheaper than
 * `JSON.parse` over a tool result that can be megabytes of content. A line whose pair is not in
 * the head window is skipped, which costs at most an early stop in the branch walk: the
 * projection's own boundary is left standing in that case.
 */
function entryLink(line: string): SessionEntryRef | null {
  const head = line.slice(0, ENTRY_LINK_SCAN_BYTES);
  const link = ENTRY_LINK_RE.exec(head);
  return link ? { id: link[1], parentId: link[2] || null } : null;
}

/**
 * The compaction boundaries of the branch a session file currently ends on, oldest first.
 *
 * `get_messages` answers with pi's model-context projection, which keeps only the *newest*
 * boundary and reports nothing but its summary and token count. The entries are all still in
 * the file — with the read/modified file lists the projection omits — so the transcript rebuilds
 * its cards from here. A file that cannot be read, or is too big to read here, yields `[]`,
 * which leaves the projection's own boundary untouched.
 *
 * Memoised per file identity: a snapshot is posted once per live surface, and the boundaries
 * only change when pi appends an entry.
 */
export function readBranchCompactions(
  filePath: string | null | undefined,
): CompactionEntry[] {
  if (!filePath) return [];
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return [];
    const cached = boundaryCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size
    ) {
      // Re-insert so the file a user keeps returning to survives the eviction.
      boundaryCache.delete(filePath);
      boundaryCache.set(filePath, cached);
      return cached.boundaries;
    }
    if (stats.size > COMPACTION_READ_LIMIT_BYTES) return [];
    const boundaries = scanBranchCompactions(filePath);
    boundaryCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      boundaries,
    });
    while (boundaryCache.size > BOUNDARY_CACHE_SIZE) {
      const oldest = boundaryCache.keys().next();
      if (oldest.done) break;
      boundaryCache.delete(oldest.value);
    }
    return boundaries;
  } catch {
    return [];
  }
}

/** One pass over the file: the boundaries of its newest branch, oldest first. */
function scanBranchCompactions(filePath: string): CompactionEntry[] {
  const refs: SessionEntryRef[] = [];
  const compactions = new Map<string, CompactionEntry>();
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    const link = entryLink(line);
    if (link) refs.push(link);
    if (!COMPACTION_LINE_RE.test(line)) continue;
    try {
      const entry = JSON.parse(line) as CompactionEntry;
      if (typeof entry.id === 'string') compactions.set(entry.id, entry);
    } catch {
      // A partially written trailing line: the entry is not durable yet.
    }
  }
  // Append order is leaf order: the last entry written is the one the runtime extends next.
  const leaf = refs.at(-1)?.id ?? null;
  return branchEntries(refs, leaf)
    .map((node) => compactions.get(node.id))
    .filter((entry): entry is CompactionEntry => entry !== undefined);
}

/** Parse one session file into metadata, or null if unreadable / not a session. */
function buildSessionInfo(filePath: string): SessionInfo | null {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > SESSION_READ_LIMIT_BYTES) return null;
    const lines = readFileSync(filePath, 'utf8').split('\n');
    let header: any = null;
    let name: string | undefined;
    let firstMessage = '';
    let messageCount = 0;
    let lastActivity = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!header) {
        if (entry.type !== 'session' || typeof entry.id !== 'string')
          return null;
        header = entry;
        continue;
      }
      if (entry.type === 'session_info') {
        name = entry.name?.trim() || undefined;
        continue;
      }
      if (entry.type !== 'message') continue;
      messageCount++;
      const msg = entry.message;
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const ts =
        typeof msg.timestamp === 'number'
          ? msg.timestamp
          : Date.parse(entry.timestamp);
      if (!Number.isNaN(ts)) lastActivity = Math.max(lastActivity, ts);
      const text = textOfContent(msg.content, ' ').trim();
      if (text && !firstMessage && msg.role === 'user') firstMessage = text;
    }
    if (!header) return null;

    const created = Date.parse(header.timestamp) || stats.mtimeMs;
    const modified = lastActivity > 0 ? lastActivity : created;
    return {
      path: filePath,
      id: header.id,
      name,
      firstMessage: firstMessage || '(no messages)',
      messageCount,
      created,
      modified,
    };
  } catch {
    return null;
  }
}

/** List sessions for a cwd, newest first. Optionally mark the current one. */
export function listSessions(
  configuredAgentDir: string,
  cwd: string,
  currentPath?: string,
): SessionInfo[] {
  const dir = sessionsDirForCwd(configuredAgentDir, cwd);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
  const infos = files
    .map(buildSessionInfo)
    .filter((s): s is SessionInfo => s !== null)
    .sort((a, b) => b.modified - a.modified);
  if (currentPath) {
    const resolvedCurrent = resolve(currentPath);
    for (const s of infos) {
      if (resolve(s.path) === resolvedCurrent) s.current = true;
    }
  }
  return infos;
}
