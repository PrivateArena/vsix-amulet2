import { useCallback, useEffect, useRef } from 'react';
import { useChatState } from '../../contexts/chat-context';
import { useTurnNavStore } from '../../stores/turn-nav-store';
import { AgentTimeline, EntryView } from '../entry-view';
import { ChatFind, scrollRangesIntoView } from '../chat-find';
import { LogoIcon } from '../logo-icon';
import { LogoText } from '../logo-text';
import { ProgressBar } from '../progress-bar';
import type { UiMessage } from '../../store';
import './message-list.scss';

/** Extension version injected into the page shell as `data-ext-version`. */
const APP_VERSION = document.body.dataset.extVersion ?? '';

/**
 * Group the flat message stream into turns: each user message starts a turn that
 * owns the assistant/tool/system messages that follow it. Wrapping each turn keeps
 * a prompt and its reply together as one scrollable block — and gives the topbar
 * navigator a stable jump target per turn (`data-turn`). Messages before the first
 * user turn form a leading, header-less group.
 */
function groupIntoTurns(
  messages: UiMessage[],
): { key: string; items: UiMessage[] }[] {
  const turns: { key: string; items: UiMessage[] }[] = [];
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) {
      turns.push({ key: m.uid, items: [m] });
    } else {
      turns[turns.length - 1].items.push(m);
    }
  }
  return turns;
}

export function EntryList({
  onScrollAtBottomChange,
}: {
  onScrollAtBottomChange?: (atBottom: boolean) => void;
}) {
  const { messages, tools, status, streaming, compacting } = useChatState();
  const ready = status.phase === 'ready';

  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const setActiveUid = useTurnNavStore((s) => s.setActiveUid);

  /** Tell the topbar navigator which turn is currently anchored at the top. */
  const syncActiveTurn = useCallback(() => {
    const log = listRef.current;
    if (!log) return;
    const turns = Array.from(log.querySelectorAll<HTMLElement>('[data-turn]'));
    if (turns.length === 0) {
      setActiveUid(null);
      return;
    }
    const edge = log.getBoundingClientRect().top + 16;
    let active = turns[0];
    for (const turn of turns) {
      if (turn.getBoundingClientRect().top > edge) break;
      active = turn;
    }
    setActiveUid(active.dataset.turn ?? null);
  }, [setActiveUid]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    syncActiveTurn();
  }, [messages, tools, streaming, compacting, syncActiveTurn]);

  // Publish the scroll handle the topbar navigator jumps through.
  useEffect(
    () =>
      useTurnNavStore.getState().register({
        scrollToTurn: (uid) => {
          const log = listRef.current;
          const turn = log?.querySelector<HTMLElement>(
            `[data-turn="${CSS.escape(uid)}"]`,
          );
          if (!log || !turn) return;
          // A jump is deliberate, so stop hugging the bottom: otherwise the next
          // streamed delta would yank the view back down mid-read.
          stickToBottom.current = false;
          const top =
            turn.getBoundingClientRect().top -
            log.getBoundingClientRect().top +
            log.scrollTop;
          log.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
        },
      }),
    [],
  );

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom !== stickToBottom.current) {
      stickToBottom.current = atBottom;
      onScrollAtBottomChange?.(atBottom);
    }
    syncActiveTurn();
  };

  /**
   * Reveal a quick-find match. Same contract as a turn jump: it's a deliberate move,
   * so stop hugging the bottom and let the reader keep what they jumped to.
   */
  const revealMatches = useCallback((ranges: Range[]) => {
    const log = listRef.current;
    if (!log) return;
    stickToBottom.current = false;
    scrollRangesIntoView(ranges, log);
  }, []);

  return (
    <>
      <div id="chat-log" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && ready && (
          <div className="welcome" data-find-skip="">
            <div className="welcome-logo">
              <LogoText />
              {APP_VERSION && (
                <span className="welcome-version">v{APP_VERSION}</span>
              )}
            </div>
            <div className="welcome-tagline">
              <LogoIcon size={28} className="welcome-glyph" />
              <p className="welcome-sub">
                Ask Pi to build a feature, fix a bug, or explain the code in
                this workspace.
              </p>
            </div>
          </div>
        )}
        {groupIntoTurns(messages).map((turn) => {
          // A turn is [user?, ...agent/system]; the user message stays a bubble
          // while the reply that follows renders as one continuous timeline.
          const hasUser = turn.items[0]?.role === 'user';
          const userMsg = hasUser ? turn.items[0] : null;
          const agentMsgs = hasUser ? turn.items.slice(1) : turn.items;
          return (
            <div
              className="turn"
              key={turn.key}
              data-turn={turn.items[0]?.role === 'user' ? turn.key : undefined}>
              {userMsg && (
                <EntryView key={userMsg.uid} message={userMsg} tools={tools} />
              )}
              {agentMsgs.length > 0 && (
                <AgentTimeline messages={agentMsgs} tools={tools} />
              )}
            </div>
          );
        })}
        {streaming && !compacting && <ProgressBar />}
        {compacting && (
          <div className="notice-msg compact-msg">Compacting context…</div>
        )}
      </div>
      <ChatFind containerRef={listRef} onReveal={revealMatches} />
    </>
  );
}
