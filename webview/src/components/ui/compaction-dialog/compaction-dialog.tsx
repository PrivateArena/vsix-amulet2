import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuCopy, LuX } from 'react-icons/lu';
import { useCopyFeedback } from '../../../hooks/use-copy-feedback';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { useCompactionHistoryStore } from '../../../stores/compaction-history-store';
import { IconButton } from '../button';
import { CompactionCard } from '../../entry-list/compaction-card';
import { clockTime } from '../../../utils/time';
import { compactionInfoOf, compactionOrdinalOf } from './compaction-view';
import './compaction-dialog.scss';

/** "Nov 4, 04:22 PM", or nothing when pi's entry carried no readable time. */
function stampOf(timestamp: number): string {
  if (!(timestamp > 0)) return '';
  const date = new Date(timestamp);
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${day}, ${clockTime(timestamp)}`;
}

/**
 * One compaction boundary, in full.
 *
 * The summary is the reason this dialog exists: it is kilobytes of text that the transcript has
 * no room for and no need to hold, so the host keeps it on disk until a row of the compact-history
 * list is clicked. Body rendering is the same settled card the live run uses, expanded — one
 * wording, one style, for a summary whoever produced it.
 */
export function CompactionDialog() {
  const openId = useCompactionHistoryStore((s) => s.openId);
  const detail = useCompactionHistoryStore((s) => s.detail);
  const missing = useCompactionHistoryStore((s) => s.detailMissing);
  const boundaries = useCompactionHistoryStore((s) => s.boundaries);
  const close = useCompactionHistoryStore((s) => s.close);
  const { copied, copy } = useCopyFeedback();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeKey(close, openId !== null);

  // Put the initial tab stop inside the dialog rather than behind the overlay, and hand focus
  // back to whatever opened it — the flyout row, which has already unmounted by now.
  useEffect(() => {
    if (!openId) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [openId]);

  if (openId === null) return null;

  const index = boundaries.findIndex((b) => b.id === openId);
  const ordinal =
    index >= 0 ? compactionOrdinalOf(boundaries.length, index) : null;
  const info = detail ? compactionInfoOf(detail) : null;
  const stamp = detail ? stampOf(detail.timestamp) : '';

  return createPortal(
    <div
      className="cd-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of the summary must not close us.
        if (e.target === e.currentTarget) close();
      }}>
      <div
        className="cd-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Compaction summary">
        <div className="cd-head">
          <span className="cd-title">
            {ordinal === null ? 'Compaction' : `Compaction #${ordinal}`}
            {stamp && <span className="cd-stamp">{stamp}</span>}
          </span>
          <span className="cd-head-actions">
            <IconButton
              variant="ghost"
              size="sm"
              icon={copied ? LuCheck : LuCopy}
              label={copied ? 'Copied' : 'Copy summary'}
              tooltipSide="bottom"
              disabled={!detail?.summary}
              onClick={() => detail && copy(detail.summary)}
            />
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuX}
              label="Close"
              tooltipSide="bottom"
              onClick={close}
            />
          </span>
        </div>

        <div className="cd-body">
          {!detail && (
            <div className="cd-empty">
              {missing
                ? 'That compaction is no longer in this session file — it was pruned, or the session moved on since the list was read.'
                : 'Loading the summary…'}
            </div>
          )}
          {info && <CompactionCard info={info} defaultExpanded />}
          {detail?.fromHook && (
            <div className="cd-note">
              This summary was written by a pi extension, not by the built-in
              summariser.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
