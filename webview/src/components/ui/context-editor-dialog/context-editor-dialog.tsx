import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuX } from 'react-icons/lu';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { Button, IconButton } from '../button';
import './context-editor-dialog.scss';

export interface ContextEditorDialogProps {
  title: string;
  /** The text as the model currently reads it — never the censored rendering. */
  initial: string;
  /** One line of context under the title (the tool name and target, usually). */
  subtitle?: string;
  /** Set while Privacy mode is on, so the human is not guessing which text is real. */
  privacyNote?: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

/** Bytes of UTF-8 text — what a context budget is actually measured in. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The text the model will read from now on.
 *
 * What leaves here goes into the conversation, so what comes *in* has to be the untouched output:
 * Privacy mode censors at paint time only, and the value the caller passes is the state value
 * (`ToolExec.resultText`), not what the card showed. When censoring is on the dialog says so out loud
 * rather than letting a masked path be sent back as a real one.
 *
 * Enter inserts a newline because a tool output is multiline; Ctrl/Cmd+Enter is the commit, which is
 * what every other surface in this panel uses for "send".
 */
export function ContextEditorDialog({
  title,
  initial,
  subtitle,
  privacyNote,
  onConfirm,
  onCancel,
}: ContextEditorDialogProps) {
  const [value, setValue] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEscapeKey(onCancel, true);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    areaRef.current?.focus();
    areaRef.current?.select();
    return () => previous?.focus?.();
  }, []);

  const bytes = useMemo(() => byteLength(value), [value]);
  const unchanged = value === initial;

  return createPortal(
    <div
      className="ce-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of the text must not throw the edit away.
        if (e.target === e.currentTarget) onCancel();
      }}>
      <div
        className="ce-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}>
        <div className="ce-head">
          <span className="ce-title">{title}</span>
          <span className="ce-head-actions">
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuX}
              label="Cancel"
              tooltipSide="bottom"
              onClick={onCancel}
            />
          </span>
        </div>
        {subtitle && <div className="ce-subtitle">{subtitle}</div>}
        <textarea
          ref={areaRef}
          className="ce-area"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (!unchanged) onConfirm(value);
            }
          }}
        />
        {privacyNote && <div className="ce-note">{privacyNote}</div>}
        <div className="ce-foot">
          <span className="ce-count">
            {value.length.toLocaleString()} chars · {bytes.toLocaleString()}{' '}
            bytes
            {unchanged ? '' : ' · replaces what the model reads'}
          </span>
          <span className="ce-foot-actions">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              startIcon={LuCheck}
              disabled={unchanged}
              title={
                unchanged
                  ? 'Nothing changed'
                  : 'Replace this text in context (Ctrl+Enter)'
              }
              onClick={() => onConfirm(value)}>
              Apply
            </Button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
