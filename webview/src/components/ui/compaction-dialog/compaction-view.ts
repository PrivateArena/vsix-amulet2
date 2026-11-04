import type {
  CompactionBoundary,
  CompactionDetail,
} from '../../../../../shared/protocol';
import type { CompactionInfo } from '../../../store';
import { formatTokens } from '../../../utils/format';

/**
 * The reading of a persisted boundary, shared by the compact-history list and its dialog so the
 * two never disagree about what a boundary is worth saying.
 *
 * A persisted entry records what the summary replaced and which files it named — nothing else.
 * The reason it ran, how long the summariser took and the post-compaction estimate live only in
 * the live `compaction_end` event, so they are absent here by fact, not by omission.
 */

/** Position of a boundary in the session's history, counted the way a reader counts: oldest is #1. */
export function compactionOrdinalOf(total: number, index: number): number {
  // The list is newest first, so the newest boundary carries the highest ordinal.
  return total - index;
}

/** One line of what a boundary did, for a row or a tooltip that has no room for more. */
export function compactionMetaLine(boundary: CompactionBoundary): string {
  const parts: string[] = [];
  if (boundary.tokensBefore > 0) {
    parts.push(`${formatTokens(boundary.tokensBefore)} in context`);
  }
  if (boundary.readCount > 0) parts.push(`${boundary.readCount} read`);
  if (boundary.modifiedCount > 0)
    parts.push(`${boundary.modifiedCount} edited`);
  return parts.length ? parts.join(' · ') : 'no detail recorded';
}

/**
 * A persisted boundary in the shape the settled compaction card already renders. `outcome` and
 * `reason` are the two fields the entry cannot answer: a stored boundary is a compaction that
 * finished, and pi does not record which of its triggers fired.
 */
export function compactionInfoOf(detail: CompactionDetail): CompactionInfo {
  return {
    outcome: 'done',
    reason: null,
    endedAt: detail.timestamp,
    summary: detail.summary,
    tokensBefore: detail.tokensBefore,
    readFiles: detail.readFiles,
    modifiedFiles: detail.modifiedFiles,
  };
}
