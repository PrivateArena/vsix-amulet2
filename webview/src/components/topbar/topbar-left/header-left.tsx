import { useMemo } from 'react';
import {
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuClipboardList,
  LuCopy,
  LuGitBranch,
} from 'react-icons/lu';
import { textOfContent } from '../../../../../shared/blocks';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import type { UiMessage } from '../../../store';
import { transcript, useTurnNavStore } from '../../../stores/turn-nav-store';
import { clockTime } from '../../../utils/time';
import { LogoIcon } from '../../logo-icon';
import { IconButton } from '../../ui/button';
import { ContextMenuItem, useCtxMenu } from '../../ui/ctx-menu';
import { Flyout } from '../../ui/flyout';
import './topbar-left.scss';

/** A jump target: one user turn, in transcript order. */
interface PromptRef {
  uid: string;
  /** 1-based position, shown to the user. */
  ordinal: number;
  text: string;
  timestamp?: number;
}

/**
 * The pi backend only sets `sessionName` once a name has been explicitly
 * assigned (rename / set_session_name); it never auto-titles a session. So we
 * fall back to the first user message — mirroring the session list's
 * `name || firstMessage` — otherwise the header would read "New chat" forever.
 */
function deriveSessionTitle(
  sessionName: string | undefined,
  messages: UiMessage[],
): string {
  const explicit = sessionName?.trim();
  if (explicit) return explicit;

  const firstUser = messages.find((m) => m.role === 'user');
  const text = oneLine(textOfContent(firstUser?.content), 90);

  return text || 'New chat';
}

function oneLine(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function promptRefs(messages: UiMessage[]): PromptRef[] {
  const refs: PromptRef[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = textOfContent(m.content).trim();
    if (!text) continue;
    refs.push({
      uid: m.uid,
      ordinal: refs.length + 1,
      text,
      timestamp: m.timestamp,
    });
  }
  return refs;
}

/** Plain-text dump of the transcript, for "Copy conversation". */
function transcriptAsText(messages: UiMessage[]): string {
  return messages
    .map((m) => ({ m, text: textOfContent(m.content).trim() }))
    .filter(({ text }) => text.length > 0)
    .map(
      ({ m, text }) =>
        `### ${m.role === 'assistant' ? 'Pi' : m.role.charAt(0).toUpperCase()}${m.role.slice(1)}\n\n${text}`,
    )
    .join('\n\n');
}

/**
 * Session title + prompt navigator.
 *
 * The transcript no longer pins the active prompt under the header (it cost a
 * fifth of the panel), so the header carries it instead: it names the turn you are
 * looking at, steps between turns with the arrows, lists every prompt on click, and
 * right-clicks to copy / branch that same prompt.
 */
export function TopbarLeft() {
  const { session, messages } = useChatState();
  const activeUid = useTurnNavStore((s) => s.activeUid);

  const prompts = useMemo(() => promptRefs(messages), [messages]);
  const found = prompts.findIndex((p) => p.uid === activeUid);
  // Before the list reports one (fresh load, empty session), show the newest turn.
  const activeIndex = found >= 0 ? found : prompts.length - 1;
  const current = activeIndex >= 0 ? prompts[activeIndex] : null;

  const sessionName = deriveSessionTitle(session?.sessionName, messages);
  const label = current ? oneLine(current.text, 120) : sessionName;

  const jumpTo = (index: number) => {
    const target = prompts[index];
    if (target) transcript.scrollToTurn(target.uid);
  };

  const menuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: 'Copy prompt',
        icon: LuCopy,
        disabled: !current,
        onSelect: () => current && actions.copyText(current.text),
      },
      {
        label: 'Branch from here',
        hint: 'edit & resend',
        icon: LuGitBranch,
        disabled: !current,
        onSelect: () => current && actions.forkFromMessage(current.text),
      },
      {
        label: 'Copy conversation',
        icon: LuClipboardList,
        separatorBefore: true,
        disabled: messages.length === 0,
        onSelect: () => actions.copyText(transcriptAsText(messages)),
      },
    ],
    [current, messages],
  );
  const ctx = useCtxMenu(menuItems, { minWidth: 210 });

  const title = current
    ? `${sessionName} · prompt ${current.ordinal} of ${prompts.length}${
        current.timestamp != null ? ` · ${clockTime(current.timestamp)}` : ''
      } — click to jump, right-click to copy or branch`
    : sessionName;

  return (
    <div className="topbar-left">
      <div className="topbar-logo" title={sessionName}>
        <LogoIcon size={16} />
      </div>

      {prompts.length > 1 && (
        <div className="turn-steppers">
          <IconButton
            variant="ghost"
            size="sm"
            icon={LuChevronLeft}
            label="Previous prompt"
            disabled={activeIndex <= 0}
            onClick={() => jumpTo(activeIndex - 1)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            icon={LuChevronRight}
            label="Next prompt"
            disabled={activeIndex >= prompts.length - 1}
            onClick={() => jumpTo(activeIndex + 1)}
          />
          <span className="turn-count">
            {current?.ordinal}
            <span className="turn-count-total">/{prompts.length}</span>
          </span>
        </div>
      )}

      <Flyout
        side="bottom-left"
        align="start"
        minWidth={Math.min(420, window.innerWidth - 48)}
        popoverClassName="turn-nav-popover"
        trigger={({ ref, triggerProps, open }) => (
          <button
            ref={ref}
            type="button"
            className={`turn-nav-trigger${open ? ' is-open' : ''}`}
            title={title}
            aria-haspopup="listbox"
            aria-expanded={triggerProps['aria-expanded']}
            onClick={triggerProps.onClick}
            onContextMenu={prompts.length > 0 ? ctx.open : undefined}>
            <span className="turn-nav-label">{label}</span>
            {prompts.length > 0 && <LuChevronDown className="turn-nav-caret" />}
          </button>
        )}>
        {({ close }) => (
          <div
            className="turn-nav-list"
            role="listbox"
            aria-label="Jump to prompt">
            {prompts.length === 0 && (
              <div className="turn-nav-empty">
                No prompts in this session yet.
              </div>
            )}
            {prompts.map((p) => (
              <button
                key={p.uid}
                type="button"
                role="option"
                aria-selected={p.uid === current?.uid}
                className={`turn-nav-item${
                  p.uid === current?.uid ? ' is-active' : ''
                }`}
                onClick={() => {
                  jumpTo(p.ordinal - 1);
                  close();
                }}>
                <span className="turn-nav-index">{p.ordinal}</span>
                <span className="turn-nav-text">{oneLine(p.text, 140)}</span>
                {p.timestamp != null && (
                  <span className="turn-nav-time">
                    {clockTime(p.timestamp)}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </Flyout>
      {ctx.menu}
    </div>
  );
}
