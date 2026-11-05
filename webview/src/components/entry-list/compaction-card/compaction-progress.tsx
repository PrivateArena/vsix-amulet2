import { actions } from '../../../apis/actions';
import type { CompactionRun } from '../../../store';
import { useRedact } from '../../../stores/privacy-store';
import { formatDuration } from '../../exec-view/tool-display';
import { useTickingClock } from '../../../hooks/use-ticking-clock';
import { Button } from '../../ui/button';
import { LoadingPulse } from '../../ui/ld';
import { compactionHint, compactionStageLabel } from './compaction-display';
import './compaction-card.scss';

/**
 * Live compaction.
 *
 * pi writes the summary on a detached provider call: it emits `compaction_start`, then
 * nothing at all until `compaction_end` — no delta of the summary text ever crosses the rpc
 * pipe. The one honest progress signal left is time, so this counts it, shows the retry
 * events the runtime does send, and offers the cancel that `abort` performs.
 */
export function CompactionProgress({ run }: { run: CompactionRun }) {
  const now = useTickingClock(true);
  const redact = useRedact();
  const elapsed = formatDuration(Math.max(0, now - run.startedAt));

  return (
    <div className="compaction-progress" role="status" aria-live="polite">
      <LoadingPulse variant="march" size="md" className="compaction-dots" />
      <span className="compaction-title">{compactionStageLabel(run)}</span>
      <span className="compaction-time">{elapsed}</span>
      <span
        className={`compaction-hint${run.retry ? ' is-retry' : ''}`}
        title={run.retry ? redact(run.retry.errorMessage ?? '') : undefined}>
        {run.retry
          ? `attempt ${run.retry.attempt}${run.retry.maxAttempts ? ` of ${run.retry.maxAttempts}` : ''} failed — ${compactionHint(run)}`
          : compactionHint(run)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="compaction-cancel"
        title="Cancel compaction"
        onClick={() => actions.abort()}>
        Cancel
      </Button>
    </div>
  );
}
