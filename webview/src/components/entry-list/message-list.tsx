import { useCallback, useEffect, useRef } from 'react';
import { useChatState } from '../../contexts/chat-context';
import { useComposerReserveStore } from '../../stores/composer-reserve-store';
import { useTurnNavStore } from '../../stores/turn-nav-store';
import { AgentTimeline, EntryView } from '../entry-view';
import { ChatFind, scrollRangesIntoView } from '../chat-find';
import { LogoIcon } from '../logo-icon';
import { LogoText } from '../logo-text';
import { ProgressBar } from '../progress-bar';
import { CompactionCard, CompactionProgress } from './compaction-card';
import { useTranscriptMenu } from './transcript-menu';
import type { UiMessage } from '../../store';
import './message-list.scss';

/** Extension version injected into the page shell as `data-ext-version`. */
const APP_VERSION = document.body.dataset.extVersion ?? '';

/** One renderable block of the transcript. */
type TranscriptBlock =
  | { kind: 'turn'; key: string; items: UiMessage[] }
  | { kind: 'compaction'; key: string; info: UiMessage['compaction'] };

/**
 * Group the flat message stream into turns: each user message starts a turn that
 * owns the assistant/tool/system messages that follow it. Wrapping each turn keeps
 * a prompt and its reply together as one scrollable block — and gives the topbar
 * navigator a stable jump target per turn (`data-turn`). Messages before the first
 * user turn form a leading, header-less group. A compaction closes the turn it lands
 * in and renders on its own: it is a context boundary, not part of anybody's reply. A
 * host `notice` (`standalone`) starts a group for the same reason.
 */
function groupTranscript(messages: UiMessage[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const m of messages) {
    if (m.role === 'compaction') {
      blocks.push({ kind: 'compaction', key: m.uid, info: m.compaction });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (
      m.role === 'user' ||
      m.standalone ||
      !last ||
      last.kind === 'compaction'
    ) {
      blocks.push({ kind: 'turn', key: m.uid, items: [m] });
    } else {
      last.items.push(m);
    }
  }
  return blocks;
}

export function EntryList({
  onScrollAtBottomChange,
}: {
  onScrollAtBottomChange?: (atBottom: boolean) => void;
}) {
  const { messages, tools, status, streaming, compaction } = useChatState();
  const ready = status.phase === 'ready';

  const listRef = useRef<HTMLDivElement | null>(null);
  // The log element is registered through the ref, not an effect: an effect with `[]`
  // deps would keep publishing the space of a detached element if this div were ever
  // re-created, and the composer has no way to notice.
  const unregisterLog = useRef<(() => void) | null>(null);
  const stickToBottom = useRef(true);
  const setActiveUid = useTurnNavStore((s) => s.setActiveUid);
  // Our own menu over the transcript: VS Code's has nothing to say about markdown.
  const menu = useTranscriptMenu(listRef);
  const blocks = groupTranscript(messages);
  /** Identity of the anchor list the topbar navigator walks (`data-turn` per turn). */
  const anchors = blocks.map((block) => block.key).join(' ');

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

  /**
   * Coalesce the anchor scan into one frame. A scroll gesture is a stream of events —
   * one per pixel of wheel movement — and each scan reads the box of every turn, so on a
   * long session the navigator would measure the whole transcript many times per frame.
   */
  const syncFrame = useRef(0);
  const requestActiveTurnSync = useCallback(() => {
    if (syncFrame.current) return;
    syncFrame.current = requestAnimationFrame(() => {
      syncFrame.current = 0;
      syncActiveTurn();
    });
  }, [syncActiveTurn]);
  useEffect(() => () => cancelAnimationFrame(syncFrame.current), []);

  /** The composer floats over the log and keeps its own tail clear of it. */
  const attachLog = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    unregisterLog.current?.();
    unregisterLog.current = el
      ? useComposerReserveStore.getState().registerLog(el)
      : null;
  }, []);
  useEffect(
    () => () => {
      unregisterLog.current?.();
      unregisterLog.current = null;
    },
    [],
  );

  // Hugging the bottom is per streamed delta: a new token has to be followed.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    // ...and streaming is also what pushes an earlier turn out from under the anchor
    // edge, so the navigator gets one coalesced look per frame, not per delta.
    requestActiveTurnSync();
  }, [messages, tools, streaming, compaction, requestActiveTurnSync]);

  // A changed anchor list is a structural fact, so it is resolved immediately rather
  // than on the next frame.
  useEffect(() => {
    syncActiveTurn();
  }, [anchors, syncActiveTurn]);

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
    requestActiveTurnSync();
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
      <div
        id="chat-log"
        ref={attachLog}
        onScroll={onScroll}
        onContextMenu={menu.open}>
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
        {blocks.map((block) => {
          if (block.kind === 'compaction') {
            return block.info ? (
              <CompactionCard key={block.key} info={block.info} />
            ) : null;
          }
          // A turn is [user?, ...agent/system]; the user message stays a bubble
          // while the reply that follows renders as one continuous timeline.
          const hasUser = block.items[0]?.role === 'user';
          const userMsg = hasUser ? block.items[0] : null;
          const agentMsgs = hasUser ? block.items.slice(1) : block.items;
          return (
            <div
              className="turn"
              key={block.key}
              data-turn={hasUser ? block.key : undefined}>
              {userMsg && (
                <EntryView key={userMsg.uid} message={userMsg} tools={tools} />
              )}
              {agentMsgs.length > 0 && (
                <AgentTimeline messages={agentMsgs} tools={tools} />
              )}
            </div>
          );
        })}
        {streaming && !compaction && <ProgressBar />}
        {compaction && <CompactionProgress run={compaction} />}
      </div>
      {menu.node}
      <ChatFind containerRef={listRef} onReveal={revealMatches} />
    </>
  );
}
