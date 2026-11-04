import { LuArchive } from 'react-icons/lu';
import { useChatState } from '../../../contexts/chat-context';
import {
  compactionHistory,
  useCompactionHistoryStore,
} from '../../../stores/compaction-history-store';
import { relativeTime } from '../../../utils/time';
import { Button } from '../../ui/button';
import { Flyout } from '../../ui/flyout';
import {
  compactionMetaLine,
  compactionOrdinalOf,
} from '../../ui/compaction-dialog/compaction-view';
import './compaction-history.scss';

/**
 * The compact-history button, beside the context meter.
 *
 * A boundary is not a chat message, and pi's history snapshot carries at most one of many — the
 * newest, hoisted to the head of the list, where a card reads as a bug. So the transcript shows
 * none of them: hovering this button asks the host for the list, which it reads off the session
 * file, and clicking a row asks for that one summary. Nothing crosses the wire until it is read.
 */
export function CompactionHistory() {
  const { session } = useChatState();
  const boundaries = useCompactionHistoryStore((s) => s.boundaries);
  const listFile = useCompactionHistoryStore((s) => s.sessionFile);

  // A list describes the file it was read from, so a session switch makes it stale before the next
  // answer lands — and hovering on the new session must not draw the old one's history.
  const currentFile = session?.sessionFile ?? null;
  const stale = listFile !== currentFile;
  const total = boundaries.length;

  return (
    <div className="compact-history-wrap">
      <Flyout
        side="top"
        align="start"
        minWidth={260}
        openOnHover
        hoverOpenDelay={180}
        onOpenChange={(open) => {
          if (open) compactionHistory.refresh();
        }}
        popoverProps={{ role: 'listbox', 'aria-label': 'Compaction history' }}
        trigger={({ ref, triggerProps }) => (
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            className={`compact-history-btn${total ? ' has-history' : ''}`}
            icon={LuArchive}
            aria-label={
              total
                ? `Compaction history: ${total} compacted, latest ${compactionMetaLine(boundaries[0])}`
                : 'Compaction history: context not compacted yet'
            }
            {...triggerProps}
          />
        )}>
        {({ close }) => (
          <div className="compact-history-panel">
            <div className="compact-history-head">Compaction history</div>
            {stale && <div className="compact-history-empty">Loading…</div>}
            {!stale && total === 0 && (
              <div className="compact-history-empty">
                This session’s context has not been compacted.
              </div>
            )}
            {!stale &&
              boundaries.map((b, i) => (
                <button
                  key={b.id}
                  type="button"
                  role="option"
                  className="compact-history-row"
                  disabled={!b.hasSummary}
                  title={
                    b.hasSummary
                      ? 'Show this summary'
                      : 'pi stored no summary text for this boundary'
                  }
                  onClick={() => {
                    // Close first: this flyout floats above a dialog, so leaving it open would
                    // cover the very summary the click just asked for.
                    close();
                    compactionHistory.open(b.id);
                  }}>
                  <span className="compact-history-ord">
                    {compactionOrdinalOf(total, i)}
                  </span>
                  <span className="compact-history-text">
                    <span className="compact-history-label">
                      Context compacted · {compactionMetaLine(b)}
                    </span>
                    <span className="compact-history-meta">
                      {b.timestamp > 0
                        ? relativeTime(b.timestamp)
                        : 'time unknown'}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        )}
      </Flyout>
    </div>
  );
}
