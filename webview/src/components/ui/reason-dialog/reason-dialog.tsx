import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuX } from 'react-icons/lu';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { Button, IconButton } from '../button';
import './reason-dialog.scss';

export interface ReasonDialogProps {
  title: string;
  /** One line under the title: what will happen, and what will not. */
  subtitle?: string;
  /**
   * What the model will read, shown as it will be read — the reason is not a subject line, so the dialog
   * previews the sentence instead of describing it. Built by the caller from the same constant the bridge
   * uses, so the preview cannot drift from what is injected.
   */
  preview?: (note: string) => string;
  placeholder?: string;
  confirmLabel: string;
  onCancel: () => void;
  /** Never an empty-string surprise: an empty note is a legitimate answer, so the caller always gets text. */
  onConfirm: (note: string) => void;
}

/**
 * The "…with reason" half of an action, in the shape pi-gate trained everyone on.
 *
 * A single line, Enter sends it, Esc declines, and empty text still performs the action — pi-gate's
 * `Abort with reason…` / `Allow with reason…` chains one `ctx.ui.input` exactly like this, and its rule is the
 * one this copies: *"Enter on empty text means the choice itself stands, without a note"*
 * (`pi-gate/prompt.ts`). That is what makes the pair of buttons one action rather than two, and why this is a
 * dialog instead of a toast with a text field: the words are the point, and they have to be typed before the
 * thing happens, not explained after.
 *
 * Modal, portal, focus-restoring: same surface language as `context-editor-dialog`, and for the same reason —
 * it opens so a person can type in it.
 */
export function ReasonDialog({
  title,
  subtitle,
  preview,
  placeholder,
  confirmLabel,
  onCancel,
  onConfirm,
}: ReasonDialogProps) {
  const [value, setValue] = useState('');
  const fieldRef = useRef<HTMLInputElement>(null);
  useEscapeKey(onCancel, true);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    fieldRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const note = value.trim();

  return createPortal(
    <div
      className="rd-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of the field must not throw the answer away.
        if (e.target === e.currentTarget) onCancel();
      }}>
      <div
        className="rd-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}>
        <div className="rd-head">
          <span className="rd-title">{title}</span>
          <span className="rd-head-actions">
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
        {subtitle && <div className="rd-subtitle">{subtitle}</div>}
        <input
          ref={fieldRef}
          className="rd-field"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onConfirm(note);
            }
          }}
        />
        {preview && <div className="rd-preview">{preview(note)}</div>}
        <div className="rd-foot">
          <span className="rd-hint">
            {note
              ? 'Goes to the model with the result'
              : 'Enter stops it without a note'}
          </span>
          <span className="rd-foot-actions">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              startIcon={LuCheck}
              title={`${confirmLabel} (Enter)`}
              onClick={() => onConfirm(note)}>
              {confirmLabel}
            </Button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
