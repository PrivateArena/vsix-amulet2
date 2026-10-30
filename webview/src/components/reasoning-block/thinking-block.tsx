import { useState } from 'react';
import { LuChevronRight } from 'react-icons/lu';
import { useChatState } from '../../contexts/chat-context';
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
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? expandedByDefault;
  const hasText = text.trim().length > 0;

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
      {hasText && <div className="reasoning-body">{text}</div>}
    </div>
  );
}
