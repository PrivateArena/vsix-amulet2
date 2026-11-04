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
