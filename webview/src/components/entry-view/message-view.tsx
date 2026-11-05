import { memo, useEffect, useRef, useState } from 'react';
import type { Attachment, ContentBlock } from '../../../../shared/protocol';
import {
  asText,
  asThinking,
  asToolCall,
  normalizeContent,
  textOfContent,
} from '../../../../shared/blocks';
import { useChatState } from '../../contexts/chat-context';
import { useRedact } from '../../stores/privacy-store';
import type { ToolExec, UiMessage } from '../../store';
import { registerCopySource } from '../../utils/md-units';
import { formatByteSize } from '../../utils/format';
import { clockTime } from '../../utils/time';
import { MdRender } from '../md-render';
import { ReasoningBlock } from '../reasoning-block';
import { ExecBlock } from '../exec-view';
import './message-view.scss';

interface MessageViewProps {
  message: UiMessage;
  tools: Record<string, ToolExec>;
}

function AttachmentGallery({ attachments }: { attachments: Attachment[] }) {
  // A picked file is named the way a path is, so the tile says the censored name while the
  // attachment itself keeps the real one for the runtime.
  const redact = useRedact();
  return (
    <div className="entry-attachments">
      {attachments.map((att) => (
        <div key={att.id} className="entry-attachment">
          {att.dataUrl ? (
            <img
              src={att.dataUrl}
              alt={redact(att.name)}
              className="entry-attachment-image"
            />
          ) : (
            <div className="entry-attachment-file">
              <span className="entry-attachment-ext">
                {att.name.split('.').pop()?.toUpperCase() ?? '?'}
              </span>
              <div className="entry-attachment-info">
                <span
                  className="entry-attachment-name"
                  title={redact(att.name)}>
                  {redact(att.name)}
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
 * used once in a while. The timestamp moved into the tooltip. The bubble is not a
 * copy unit — its paragraphs already are, and the gallery beside them is not text —
 * it only declares the message it owns, for the menu to copy and to branch from.
 */
function UserBubble({
  message,
  tools,
  attachments,
}: MessageViewProps & { attachments: Attachment[] | undefined }) {
  const clampRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const source = textOfContent(message.content).trim();

  // The menu hands this exact string to "Branch from here", which pi matches against
  // the runtime's history by text — so it is the message, never its rendering.
  useEffect(() => registerCopySource(bubbleRef.current, source), [source]);

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
    <div
      ref={bubbleRef}
      className="entry-bubble"
      data-branch=""
      title={
        message.timestamp != null
          ? `${clockTime(message.timestamp)} · right-click to copy or branch`
          : 'Right-click to copy or branch'
      }>
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
    </div>
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
