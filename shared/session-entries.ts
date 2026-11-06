import type {
  CompactionBoundary,
  CompactionDetail,
  CompactionEntry,
  CompactionSummaryMessage,
  HistoryMessage,
  SessionEntryRef,
} from './protocol';

/**
 * pi's persisted session entries, read by the two domain questions the UI asks of them: *which
 * compactions happened on the branch this transcript is on*, and *what did this one say*.
 * `get_messages` cannot answer either — it answers with the model context projection, which keeps
 * only the newest boundary and only its summary and token count.
 */

/** The role pi gives a projected compaction boundary. Not a chat message: see {@link stripCompactionBoundaries}. */
export const COMPACTION_ROLE = 'compactionSummary';

/** Whether a history line is one of those boundaries. */
export function isCompactionSummaryMessage(
  message: HistoryMessage | { role: string },
): message is CompactionSummaryMessage {
  return message.role === COMPACTION_ROLE;
}

/**
 * Entries on the path that ends at `leafId`, root → leaf, or `[]` for an in-memory/empty session.
 *
 * A session file is an append log, not a branch: forks and edits leave sibling entries behind,
 * and only `parentId` says which of them the live conversation descends from. Walking from the
 * leaf is what keeps a boundary of an abandoned branch from surfacing as a card.
 */
export function branchEntries<T extends SessionEntryRef>(
  entries: T[],
  leafId: string | null,
): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.id, entry);
  const path: T[] = [];
  const seen = new Set<string>();
  let cursor = leafId ? byId.get(leafId) : undefined;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * Drop the projected compaction boundaries from a history snapshot.
 *
 * They are not chat messages, and the snapshot holds at most one of them — the newest — so
 * drawing them in the transcript is both a half-truth and the position bug it caused. The
 * compact-history list answers the same question off the persisted entries instead, and does it
 * on demand. Copy-on-change, like the other history helpers.
 */
export function stripCompactionBoundaries(
  messages: HistoryMessage[],
): HistoryMessage[] {
  if (!messages.some(isCompactionSummaryMessage)) return messages;
  return messages.filter((m) => !isCompactionSummaryMessage(m));
}

/** Epoch ms of a persisted entry, or 0 when it carries no readable time (the UI then omits it). */
function entryTime(entry: CompactionEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** One persisted boundary as a list row: identity and size, no summary text. */
export function compactionBoundaryOf(
  entry: CompactionEntry,
): CompactionBoundary {
  return {
    id: entry.id,
    timestamp: entryTime(entry),
    tokensBefore: entry.tokensBefore ?? 0,
    readCount: entry.details?.readFiles?.length ?? 0,
    modifiedCount: entry.details?.modifiedFiles?.length ?? 0,
    hasSummary: !!entry.summary?.trim(),
  };
}

/**
 * One persisted boundary in full, for the dialog that opens when a row is clicked. Of the entry's
 * fields this is everything with a rendering value: `firstKeptEntryId` only says what the
 * projection kept, `systemMessage` is a whole prompt, and `usage` describes a summarisation call
 * the user is not asking about.
 */
export function compactionDetailOf(entry: CompactionEntry): CompactionDetail {
  return {
    id: entry.id,
    timestamp: entryTime(entry),
    tokensBefore: entry.tokensBefore ?? 0,
    summary: entry.summary ?? '',
    readFiles: entry.details?.readFiles,
    modifiedFiles: entry.details?.modifiedFiles,
    fromHook: entry.fromHook,
  };
}

/**
 * List rows for a branch's boundaries, newest first: the newest compaction is the one that
 * describes the context the user is reading, and a list of them reads like a history.
 */
export function compactionBoundaryList(
  entries: CompactionEntry[],
): CompactionBoundary[] {
  return entries.map(compactionBoundaryOf).reverse();
}

// ---------------------------------------------------------------------------
// Context edits (Omit / Edit context content)
// ---------------------------------------------------------------------------

/**
 * One persisted entry, reduced to the fields the two context-surgery questions need.
 *
 * A reader that scans a session file for `context_edit` and `compaction` lines can hand this to the
 * helpers below without modelling every entry type pi writes — the file also carries model changes,
 * usage rows and custom entries, and none of them matters here.
 */
export interface SessionEntryLike extends SessionEntryRef {
  type: string;
  /** Every persisted entry carries one; a reader that only walks ids can leave it out. */
  timestamp?: string;
  /** `context_edit`: the entry whose model-context contribution this line replaces. */
  targetId?: string;
  /** `context_edit`: null omits the target, a value replaces only its content. */
  replacement?: { content?: unknown } | null;
  /** `compaction`: first entry of the range the projection kept; null keeps nothing older. */
  firstKeptEntryId?: string | null;
}

/** A {@link SessionEntryLike} that is definitely a context edit (validated by {@link isContextEditEntry}). */
export interface ContextEditEntryLike extends SessionEntryLike {
  type: 'context_edit';
  targetId: string;
}

/** Whether one persisted line is the append-only context edit the surgery feature writes. */
export function isContextEditEntry(
  entry: SessionEntryLike,
): entry is ContextEditEntryLike {
  return (
    entry.type === 'context_edit' &&
    typeof entry.targetId === 'string' &&
    entry.targetId.length > 0
  );
}

/**
 * The context edits that apply to the branch ending at `leafId`, keyed by their target.
 *
 * "Latest edit on the active branch wins" is pi's own projection rule — it folds the branch's edits
 * into a map in file order, so a second omit or a restore of the same entry supersedes the first.
 * Walking the branch instead of the file is what keeps an edit made before a fork (or on a branch
 * the user abandoned) from describing the conversation the user is reading.
 */
export function collectContextEdits(
  entries: SessionEntryLike[],
  leafId: string | null,
): Map<string, ContextEditEntryLike> {
  const edits = new Map<string, ContextEditEntryLike>();
  for (const entry of branchEntries(entries, leafId)) {
    if (isContextEditEntry(entry)) edits.set(entry.targetId, entry);
  }
  return edits;
}

/**
 * The newest compaction boundary on the branch ending at `leafId`, or undefined when the branch
 * never compacted. Its `firstKeptEntryId` is what the projection kept from before it — null means
 * the boundary retains nothing older than itself.
 */
export function newestCompactionCutoff(
  entries: SessionEntryLike[],
  leafId: string | null,
): string | undefined {
  const path = branchEntries(entries, leafId);
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].type === 'compaction') return path[i].id;
  }
  return undefined;
}

/**
 * Whether one entry of this branch is already out of the model's context because the newest
 * compaction summarised past it. The first kept entry and everything after it count as kept, so an
 * edit aimed at them still reaches the model; an id that is not on the branch is not reported as
 * compacted away, because "use Compact instead" would be a lie about a row the user cannot see.
 */
export function isBeforeCompactionCutoff(
  entries: SessionEntryLike[],
  leafId: string | null,
  entryId: string,
): boolean {
  const path = branchEntries(entries, leafId);
  const boundaryIndex = path.reduce(
    (found, entry, index) => (entry.type === 'compaction' ? index : found),
    -1,
  );
  if (boundaryIndex < 0) return false;
  const entryIndex = path.findIndex((entry) => entry.id === entryId);
  if (entryIndex < 0) return false;
  const keptId = path[boundaryIndex].firstKeptEntryId;
  // `null` is a self-retaining boundary: it keeps no preceding entry at all.
  const keptIndex =
    keptId === undefined || keptId === null
      ? boundaryIndex
      : path.findIndex((entry) => entry.id === keptId);
  return entryIndex < (keptIndex < 0 ? boundaryIndex : keptIndex);
}
