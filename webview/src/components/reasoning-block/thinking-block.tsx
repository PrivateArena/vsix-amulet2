import { useEffect, useRef, useState } from 'react';
import { LuChevronRight } from 'react-icons/lu';
import { useChatState } from '../../contexts/chat-context';
import { useRedact } from '../../stores/privacy-store';
import { registerCopySource } from '../../utils/md-units';
import './reasoning-block.scss';

interface ThinkingBlockProps {
  text: string;
  /** True while the model is still streaming this reasoning block. */
  active?: boolean;
}

export function ReasoningBlock({ text, active = false }: ThinkingBlockProps) {
  // The host preference (menu: "Uncollapse thinking") is the default for every
  // block; clicking a header overrides it for that block alone.
  const expandedByDefault = useChatState().expandThinking;
  const redact = useRedact();
  // Reasoning is the most quotable text in a transcript and the most likely to name a private
  // path, so the block shows and hands out the censored copy while keeping the original registered.
  const shown = redact(text);
  const [manual, setManual] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const expanded = manual ?? expandedByDefault;
  const hasText = text.trim().length > 0;

  // Reasoning arrives as text and is shown as text, so the copy source is the raw
  // block — newlines and all.
  useEffect(
    () => registerCopySource(bodyRef.current, shown, { pre: true, raw: text }),
    [shown, text],
  );

  // Nothing to show once thinking is done and produced no content.
  if (!hasText && !active) return null;

  return (
    <div
      className={`reasoning-block${expanded ? ' is-expanded' : ''}${
        active ? ' is-active' : ''
      }`}>
      <button
        type="button"
        className="reasoning-summary"
        onClick={() => setManual(!(manual ?? expandedByDefault))}
        aria-expanded={expanded}
        disabled={!hasText}>
        <LuChevronRight className="reasoning-chevron" aria-hidden="true" />
        <span className="reasoning-label">
          {active ? 'Thinking' : 'Thought'}
        </span>
        {active && (
          <span className="reasoning-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </button>
      {hasText && (
        <div className="reasoning-body" ref={bodyRef} data-copy-unit="thinking">
          {shown}
        </div>
      )}
    </div>
  );
}
