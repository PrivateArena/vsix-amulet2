import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { LuCheck, LuCopy, LuGitBranch } from 'react-icons/lu';
import type { Attachment, ContentBlock } from '../../../../shared/protocol';
import {
  asText,
  asThinking,
  asToolCall,
  normalizeContent,
  textOfContent,
} from '../../../../shared/blocks';
import { actions } from '../../apis/actions';
import { useChatState } from '../../contexts/chat-context';
import type { ToolExec, UiMessage } from '../../store';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { formatByteSize } from '../../utils/format';
import { clockTime } from '../../utils/time';
import { ContextMenuItem, useCtxMenu } from '../ui/ctx-menu';
import { MdRender } from '../md-render';
import { ReasoningBlock } from '../reasoning-block';
import { ExecBlock } from '../exec-view';
import './message-view.scss';

interface MessageViewProps {
  message: UiMessage;
  tools: Record<string, ToolExec>;
}

/** Copy/branch actions for a user turn, anchored on right-click. */
function useUserMessageMenu(message: UiMessage) {
  const text = useMemo(() => textOfContent(message.content).trim(), [message]);
  const { copied, copy } = useCopyFeedback();

  const items = useMemo<ContextMenuItem[]>(
    () => [
      {
        label: 'Copy message',
        icon: LuCopy,
        onSelect: () => copy(text),
      },
      {
        label: 'Branch from here',
        hint: 'edit & resend',
        icon: LuGitBranch,
        onSelect: () => actions.forkFromMessage(text),
      },
    ],
    [text, copy],
  );

  const ctx = useCtxMenu(items, { minWidth: 180 });
  return { ctx, copied };
}

function AttachmentGallery({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="entry-attachments">
      {attachments.map((att) => (
        <div key={att.id} className="entry-attachment">
          {att.dataUrl ? (
            <img
              src={att.dataUrl}
              alt={att.name}
              className="entry-attachment-image"
            />
          ) : (
            <div className="entry-attachment-file">
              <span className="entry-attachment-ext">
                {att.name.split('.').pop()?.toUpperCase() ?? '?'}
              </span>
              <div className="entry-attachment-info">
                <span className="entry-attachment-name" title={att.name}>
                  {att.name}
                </span>
                <span className="entry-attachment-size">
                  {formatByteSize(att.size)}
                </span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A user turn. A long question is still clamped with an expand toggle so it can't
 * dominate the panel while the answer streams below it.
 *
 * Copy / branch are a right-click menu rather than a hover toolbar: the transcript
 * is dense, and a floating pill over the bubble costs a line of it for actions
 * used once in a while. The timestamp moved into the tooltip.
 */
function UserBubble({
  message,
  tools,
  attachments,
}: MessageViewProps & { attachments: Attachment[] | undefined }) {
  const clampRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const { ctx, copied } = useUserMessageMenu(message);

  // Measure only while collapsed: expanding drops the max-height, so the
  // element stops overflowing and the toggle would remove itself.
  useEffect(() => {
    if (expanded) return;
    const el = clampRef.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    // Catches panel resizes — a narrower sidebar reflows text taller.
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, message]);

  return (
    <>
      <div
        className={`entry-bubble${ctx.isOpen ? ' is-ctx-open' : ''}`}
        title={
          message.timestamp != null
            ? `${clockTime(message.timestamp)} · right-click to copy or branch`
            : 'Right-click to copy or branch'
        }
        onContextMenu={ctx.open}>
        <div
          ref={clampRef}
          className={`bubble-clamp${expanded ? ' is-expanded' : ''}`}>
          {attachments && attachments.length > 0 && (
            <AttachmentGallery attachments={attachments} />
          )}
          {normalizeContent(message.content).map((block, i) =>
            renderBlock(block, i, tools),
          )}
        </div>
        {overflowing && (
          <button
            type="button"
            className="bubble-toggle"
            onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {copied && (
          <span className="entry-copied" role="status">
            <LuCheck size={11} />
            Copied
          </span>
        )}
      </div>
      {ctx.menu}
    </>
  );
}

export const EntryView = memo(function EntryView({
  message,
  tools,
}: MessageViewProps) {
  const { role, streaming } = message;
  const content = normalizeContent(message.content);
  const { userAttachments } = useChatState();
  const isAssistant = role === 'assistant';
  const isUser = role === 'user';

  // Get attachments from local store (not stored by pi)
  const attachments = isUser ? userAttachments.get(message.uid) : undefined;

  return (
    <div
      className={`entry${isAssistant ? ' agent-entry' : ''}${
        isUser ? ' user-entry' : ''
      }`}>
      <div className="entry-body">
        {!isUser && (
          <div className="entry-role">{role === 'assistant' ? 'Pi' : role}</div>
        )}
        <div className="entry-content">
          {isUser ? (
            <UserBubble
              message={message}
              tools={tools}
              attachments={attachments}
            />
          ) : (
            <>
              {content.map((block, i) =>
                renderBlock(
                  block,
                  i,
                  tools,
                  streaming && i === content.length - 1,
                ),
              )}
              {streaming && content.length === 0 && (
                <span className="caret-blink" />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

function renderBlock(
  block: ContentBlock,
  index: number,
  tools: Record<string, ToolExec>,
  active = false,
) {
  const text = asText(block);
  if (text) return <MdRender key={index}>{text.text}</MdRender>;

  const thinking = asThinking(block);
  if (thinking)
    return (
      <ReasoningBlock key={index} text={thinking.thinking} active={active} />
    );

  const call = asToolCall(block);
  if (call)
    return (
      <ExecBlock
        key={call.id ?? index}
        tool={tools[call.id]}
        name={call.name}
        args={call.arguments}
        tools={tools}
      />
    );

  return null;
}
