import type { CompactionInfo, CompactionRun } from '../../../store';
import { formatTokens } from '../../../utils/format';
import { formatDuration } from '../../exec-view/tool-display';

/**
 * The wording of a compaction card, kept away from the components so the two surfaces
 * (live run, settled boundary) agree and the arithmetic stays testable without a DOM.
 */

/** Headline of a settled compaction, derived from nothing but its own record. */
export function compactionTitle(info: CompactionInfo): string {
  if (info.outcome === 'aborted') return 'Compaction cancelled';
  if (info.outcome === 'failed') return 'Compaction failed';
  return 'Context compacted';
}

/** Why this compaction ran, in the words the transcript has room for. */
export function compactionReasonLabel(info: CompactionInfo): string {
  switch (info.reason) {
    case 'threshold':
      return 'auto · context threshold';
    case 'overflow':
      return 'auto · context overflow';
    default:
      return '';
  }
}

/** What the runtime is doing right now, in the words that fit one line. */
export function compactionStageLabel(run: CompactionRun): string {
  switch (run.reason) {
    case 'threshold':
      return 'Auto-compacting context';
    case 'overflow':
      return 'Recovering from a context overflow';
    default:
      return 'Compacting context';
  }
}

/**
 * pi's own numbering: `attempt` is the call the summariser is about to make, not a count of
 * failures, and `maxAttempts` is its retry budget — so the pair reads the way pi's TUI does.
 */
export function compactionRetryLabel(run: CompactionRun): string {
  const { attempt, maxAttempts } = run.retry ?? {};
  if (attempt == null) return 'retrying';
  return `retrying (${attempt}${maxAttempts ? `/${maxAttempts}` : ''})`;
}

/** Sub-line under the timer: what the wait is spent on, or how many tries it has taken. */
export function compactionHint(run: CompactionRun): string {
  return run.retry ? compactionRetryLabel(run) : 'writing the summary';
}

/**
 * Token delta of one compaction. `tokensAfter` is pi's own heuristic estimate over the
 * rebuilt context — the runtime reports no post-compaction usage until the next assistant
 * response, so this is the only "after" figure there is.
 */
export function compactionTokenDeltaOf(info: CompactionInfo): {
  before: number;
  after: number | null;
  freed: number | null;
  percent: number | null;
} {
  const before = info.tokensBefore ?? 0;
  const after =
    typeof info.tokensAfter === 'number' && info.tokensAfter > 0
      ? info.tokensAfter
      : null;
  const freed =
    after == null || before <= 0 ? null : Math.max(0, before - after);
  return {
    before,
    after,
    freed,
    percent:
      freed == null || before <= 0
        ? null
        : Math.min(100, Math.round((freed / before) * 100)),
  };
}

/** Compact readout of what the compaction cost and released. */
export function compactionStats(info: CompactionInfo): string[] {
  const parts: string[] = [];
  const reason = compactionReasonLabel(info);
  if (reason) parts.push(reason);
  const { before, after, freed, percent } = compactionTokenDeltaOf(info);
  if (before > 0) {
    parts.push(
      after == null
        ? `${formatTokens(before)} tokens in context`
        : `${formatTokens(before)} → ~${formatTokens(after)} tokens`,
    );
  }
  if (freed != null && percent != null) {
    parts.push(`freed ${formatTokens(freed)} (${percent}%)`);
  }
  if (info.durationMs != null) parts.push(formatDuration(info.durationMs));
  return parts;
}
