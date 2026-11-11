import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuX } from 'react-icons/lu';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { usePromptDialogStore } from '../../../stores/prompt-dialog-store';
import { useRedact } from '../../../stores/privacy-store';
import { composer } from '../../../stores/composer-store';
import {
  argFieldsOf,
  expandedTextOf,
  hiddenArgsOf,
  MAX_ARG_FIELDS,
} from '../../../utils/prompt-insert';
import { Button, IconButton } from '../button';
import './prompt-dialog.scss';

/**
 * One prompt template or skill, expanded live, with an Insert button.
 *
 * The layout is the order of the work: read the prompt, fill its arguments, insert it. The
 * preview is the expanded text and nothing else — the same `substituteArgs` pass pi would have
 * run (`shared/prompt-template.ts`), so what is on screen is the token cost of what gets sent,
 * including the arguments that came out empty and the `${1:-default}` that replaced them.
 *
 * Inserting rather than sending is the point. pi expands exactly one command per message, so a
 * second `/prompt` in a draft is swallowed by the first; prose it was handed cannot swallow
 * anything, so any number of prompts can be dropped into one draft before it goes out.
 */
export function PromptDialog() {
  const target = usePromptDialogStore((s) => s.target);
  const resource = usePromptDialogStore((s) => s.resource);
  const error = usePromptDialogStore((s) => s.error);
  const insertError = usePromptDialogStore((s) => s.insertError);
  const form = usePromptDialogStore((s) => s.form);
  const setField = usePromptDialogStore((s) => s.setField);
  const close = usePromptDialogStore((s) => s.close);
  const insert = usePromptDialogStore((s) => s.insert);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Set on the way out through Insert, so focus goes to the draft and not to the trigger. */
  const inserting = useRef(false);
  // Privacy mode may mask a path in the preview, but `insert` expands from the untouched body the
  // host read, never from what was painted here — same rule as every other text leaf.
  const redact = useRedact();

  useEscapeKey(close, target !== null);

  // Initial tab stop inside the dialog, focus back where it came from on close. An Insert is the
  // exception: the text went into the composer, so the caret belongs there — restoring the trigger
  // would hand the keystrokes to the button the human clicked to open this form.
  useEffect(() => {
    if (!target) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (inserting.current) {
        inserting.current = false;
        composer.focus();
        return;
      }
      previous?.focus?.();
    };
  }, [target]);

  const fields = useMemo(
    () => (target && resource ? argFieldsOf(target, resource) : []),
    [target, resource],
  );
  const hidden = useMemo(
    () => (target && resource ? hiddenArgsOf(target, resource) : 0),
    [target, resource],
  );
  const expanded = useMemo(
    () => (target && resource ? expandedTextOf(target, resource, form) : null),
    [target, resource, form],
  );
  // Censoring runs rules over the whole expanded body, and this recomputes on every keystroke in
  // an argument field — so it is memoised on the value, not recomputed inside the `<pre>`.
  const preview = useMemo(
    () => (expanded === null ? null : redact(expanded)),
    [expanded, redact],
  );

  if (!target) return null;

  const doInsert = (): void => {
    inserting.current = true;
    insert();
  };

  const kindLabel = target.kind === 'skill' ? 'skill' : 'prompt';
  const invocation = `${target.kind === 'skill' ? '/skill:' : '/'}${target.label}`;

  return createPortal(
    <div
      className="pd-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of a field must not throw the draft away.
        if (e.target === e.currentTarget) close();
      }}>
      <div
        className="pd-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Insert ${kindLabel} ${target.label}`}>
        <div className="pd-head">
          <span className="pd-title">
            {invocation}
            <span className="pd-kind">{kindLabel}</span>
          </span>
          <span className="pd-head-actions">
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuX}
              label="Close"
              tooltipSide="bottom"
              onClick={close}
            />
          </span>
        </div>
        {(target.description || resource?.path) && (
          <div className="pd-subtitle">
            {target.description ? redact(target.description) : ''}
            {target.description && resource?.path ? ' · ' : ''}
            {resource ? (
              <code className="pd-path">{redact(resource.path)}</code>
            ) : null}
          </div>
        )}

        <div className="pd-body">
          <div className="pd-section">
            <span className="pd-section-title">
              {expanded === null ? 'Prompt' : 'What lands in the composer'}
            </span>
            {!resource && !error && (
              <div className="pd-empty">Reading {target.name}…</div>
            )}
            {error && (
              <div className="pd-error">
                {redact(error)}
                <div className="pd-note">
                  Nothing was lost: the draft still holds{' '}
                  <code>{invocation}</code> as you typed it, and pi expands that
                  itself.
                </div>
              </div>
            )}
            {preview !== null && <pre className="pd-preview">{preview}</pre>}
          </div>

          {resource && fields.length > 0 && (
            <div className="pd-section">
              <span className="pd-section-title">Arguments</span>
              {fields.map((field) => (
                <label
                  className="pd-field"
                  key={`${field.kind}-${field.position}`}>
                  <span className="pd-field-label">{field.label}</span>
                  <textarea
                    className="pd-input"
                    rows={2}
                    spellCheck={false}
                    value={
                      field.kind === 'rest'
                        ? form.rest
                        : (form.args[field.position] ?? '')
                    }
                    placeholder={field.placeholder}
                    onChange={(e) => setField(field, e.target.value)}
                    onKeyDown={(e) => {
                      // Same commit key as the context editor: Enter is a newline in a field.
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        doInsert();
                      }
                    }}
                  />
                </label>
              ))}
              <div className="pd-note">
                {hidden > 0
                  ? `This template reads ${hidden + MAX_ARG_FIELDS} arguments; the form shows the first ${MAX_ARG_FIELDS}, and the rest are filled from what the draft already carried.`
                  : 'Every line you type here is folded into one when the prompt is inserted.'}
              </div>
            </div>
          )}
        </div>

        <div className="pd-foot">
          {insertError ? (
            <span className="pd-error pd-error-foot">{insertError}</span>
          ) : (
            <span className="pd-count">
              {expanded === null
                ? 'Waiting for the prompt file'
                : `${expanded.length.toLocaleString()} chars · inserts into the draft, sends nothing`}
            </span>
          )}
          <span className="pd-foot-actions">
            <Button variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              startIcon={LuCheck}
              disabled={expanded === null}
              title={
                expanded === null
                  ? 'The prompt file is not on screen yet'
                  : 'Insert into the composer (Ctrl+Enter)'
              }
              onClick={doInsert}>
              Insert
            </Button>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
