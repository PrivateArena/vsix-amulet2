import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuCopy, LuRefreshCw, LuX } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import { useCopyFeedback } from '../../../hooks/use-copy-feedback';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { useSessionInfoStore } from '../../../stores/session-info-store';
import { IconButton } from '../button';
import { buildSessionInfo } from './session-info';
import './session-info-dialog.scss';

/** Copy affordance for the long, unselectable-by-keystroke values (path, id). */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className={`si-copy${copied ? ' is-copied' : ''}`}
      aria-label={copied ? `${label} copied` : `Copy the ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => copy(text)}>
      {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />}
    </button>
  );
}

/**
 * "Show session info" as a chat-panel dialog instead of a VS Code notification.
 *
 * The figures come from the two HostMessages the webview already keeps — `state`
 * (identity) and `stats` (`get_session_stats`, the same call pi's `/session`
 * command makes) — and are refreshed on open and on every refresh click.
 */
export function SessionInfoDialog() {
  const open = useSessionInfoStore((s) => s.open);
  const close = useSessionInfoStore((s) => s.close);
  const { session, stats, status } = useChatState();
  const { copied, copy } = useCopyFeedback();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEscapeKey(close, open);

  // Pull identity and counts on open: the host only pushes `stats` on turn_end, and a
  // session switch leaves the previous session's figures in the store until it answers.
  const refresh = () => {
    actions.requestState();
    actions.requestStats();
  };
  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Put the initial tab stop inside the dialog rather than behind the overlay, and hand
  // focus back to the topbar trigger on close (the flyout that opened us already did so).
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  const info = buildSessionInfo(session, stats);
  // The host answers `requestStats`/`requestState` with nothing when the runtime is down,
  // so warn that the figures may be the previous run's rather than presenting them as live.
  const stale = status.phase !== 'ready';

  return createPortal(
    <div
      className="si-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of a copyable value must not close us.
        if (e.target === e.currentTarget) close();
      }}>
      <div
        className="si-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Session Info">
        <div className="si-head">
          <span className="si-title">Session Info</span>
          <span className="si-head-actions">
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuRefreshCw}
              label="Refresh"
              tooltipSide="bottom"
              onClick={refresh}
            />
            <IconButton
              variant="ghost"
              size="sm"
              icon={copied ? LuCheck : LuCopy}
              label={copied ? 'Copied' : 'Copy all'}
              tooltipSide="bottom"
              disabled={!info.text}
              onClick={() => copy(info.text)}
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

        <div className="si-body">
          {info.waiting && (
            <div className="si-empty">
              {stale
                ? 'Pi is not running, so there is no session to describe yet.'
                : 'No session data yet — start a prompt to fill in the counters.'}
            </div>
          )}
          {stale && !info.waiting && (
            <div className="si-stale">
              Pi is not running — these figures are the last ones reported.
            </div>
          )}
          {info.sections.map((section) => (
            <section className="si-section" key={section.title}>
              <h3 className="si-section-title">{section.title}</h3>
              <dl className="si-rows">
                {section.rows.map((row) => (
                  <div className="si-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      <span className={`si-value${row.mono ? ' si-mono' : ''}`}>
                        {row.value}
                      </span>
                      {row.copy != null && (
                        <CopyButton text={row.copy} label={row.label} />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
