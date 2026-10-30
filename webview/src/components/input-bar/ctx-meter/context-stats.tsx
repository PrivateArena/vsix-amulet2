import { LuMinimize2 } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import { useConfirm } from '../../../stores/confirm-store';
import { formatTokens } from '../../../utils/format';
import { Button } from '../../ui/button';
import { Flyout } from '../../ui/flyout';
// Reused so the action row here looks exactly like every other menu in the app.
import '../../ui/menu-item/menu.scss';
import './context-stats.scss';

const R = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

function valueToneClass(pct: number): string {
  if (pct >= 90) return 'ctx-val-danger';
  if (pct >= 70) return 'ctx-val-warning';
  return 'ctx-val-accent';
}

export function ContextMeter() {
  const { stats, streaming, compacting } = useChatState();
  const confirm = useConfirm();

  if (!stats) return null;

  const pct = Math.min(
    100,
    Math.max(0, Math.round(stats.contextUsage.percent)),
  );

  const handleCompact = async () => {
    const ok = await confirm({
      title: 'Compact context',
      message:
        'Compact the conversation to reduce context usage and continue working within the context window.',
      confirmLabel: 'Compact',
    });
    if (ok) actions.compact();
  };

  const offset = CIRCUMFERENCE * (1 - pct / 100);
  const input = stats.tokens.input ?? 0;
  const output = stats.tokens.output ?? 0;
  const compactDisabled = streaming || compacting;

  return (
    <div className="ctx-meter-wrap">
      <Flyout
        side="top"
        align="center"
        minWidth={220}
        popoverProps={{ role: 'dialog', 'aria-label': 'Context usage' }}
        trigger={({ ref, triggerProps }) => (
          <Button
            ref={ref}
            variant="ghost"
            icon={() => (
              <svg
                className="ctx-meter"
                viewBox="0 0 16 16"
                width="18"
                height="18"
                aria-hidden="true"
                style={
                  {
                    '--ctx-color': `var(--pintra-${pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'info'})`,
                  } as React.CSSProperties
                }>
                <circle className="ctx-meter-track" cx="8" cy="8" r={R} />
                <circle
                  className="ctx-meter-fill"
                  cx="8"
                  cy="8"
                  r={R}
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={offset}
                />
              </svg>
            )}
            aria-label={`Context usage: ${pct}%`}
            title={`Context usage: ${pct}%`}
            aria-haspopup="dialog"
            {...triggerProps}
          />
        )}>
        {({ close }) => (
          <div className="ctx-popup-body">
            <div className="ctx-popup-title">Context usage</div>
            <div className="ctx-popup-grid">
              <div className="ctx-popup-row">
                <span>Tokens</span>
                <strong className={valueToneClass(pct)}>
                  {formatTokens(stats.contextUsage.tokens)} /{' '}
                  {formatTokens(stats.contextUsage.contextWindow)}
                  &nbsp;({pct}%)
                </strong>
              </div>
              <div className="ctx-popup-row">
                <span>Input / Output</span>
                <strong>
                  {formatTokens(input)} / {formatTokens(output)}
                </strong>
              </div>
              {stats.tokens.cacheRead + stats.tokens.cacheWrite > 0 && (
                <div className="ctx-popup-row">
                  <span>Cached Read / Write</span>
                  <strong>
                    {formatTokens(stats.tokens.cacheRead)} /{' '}
                    {formatTokens(stats.tokens.cacheWrite)}
                  </strong>
                </div>
              )}
              {stats.cost > 0 && (
                <div className="ctx-popup-row">
                  <span>Cost</span>
                  <strong>${stats.cost.toFixed(4)}</strong>
                </div>
              )}
              <div className="ctx-popup-row">
                <span>Messages / Tools</span>
                <strong>
                  {stats.totalMessages} /{' '}
                  {(stats.toolCalls ?? 0) + (stats.toolResults ?? 0)}
                </strong>
              </div>
            </div>
            <div className="ctx-popup-actions" role="menu">
              <Button
                type="button"
                role="menuitem"
                className={`menu-item${compactDisabled ? ' disabled' : ''}`}
                disabled={compactDisabled}
                onClick={() => {
                  close();
                  void handleCompact();
                }}>
                <span className="menu-icon">
                  <LuMinimize2 size={14} />
                </span>
                <span className="menu-label">Compact conversation</span>
              </Button>
            </div>
          </div>
        )}
      </Flyout>
    </div>
  );
}
