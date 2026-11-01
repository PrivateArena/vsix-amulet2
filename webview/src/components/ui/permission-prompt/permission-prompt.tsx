import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExtensionUiRequest } from '../../../../../shared/protocol';
import { actions } from '../../../apis/actions';
import { useChatDispatch, useChatState } from '../../../contexts/chat-context';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { useListNavigation } from '../../../hooks/use-list-navigation';
import { Button } from '../button';
import {
  buildUiResponse,
  dialogDraft,
  dialogMessage,
  dialogOptions,
  dialogTitle,
  type UiAnswer,
} from './ui-response';

import './permission-prompt.scss';

/**
 * pi-gate's approval dialog (and any other pi extension UI) inside the chat panel.
 *
 * The host forwards `extension_ui_request` to this webview and waits; pi keeps the tool call parked
 * until it gets an `extension_ui_response`, so every path out of here must answer exactly once —
 * including Escape, which means "no answer" and therefore a deny (never an implicit allow).
 */
export function PermissionPrompt() {
  const pendingUi = useChatState().pendingUi;
  const request = pendingUi[0];
  if (!request) return null;
  // Keyed by id so per-dialog state (focus ring, draft text) can't leak into the next question.
  return (
    <PromptDialog
      key={request.id}
      request={request}
      queued={pendingUi.length - 1}
    />
  );
}

interface PromptDialogProps {
  request: ExtensionUiRequest;
  /** Requests still waiting behind this one (pi-gate asks one question at a time per call). */
  queued: number;
}

function PromptDialog({ request, queued }: PromptDialogProps) {
  const dispatch = useChatDispatch();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Proof of paint for the host: it cannot tell whether this webview is on screen (VS Code's `visible`
  // flag is only pushed by `onDidChangeVisibility` and lies in both directions), and its native fallback
  // must not fire while the human is looking at this dialog. A detached or hidden webview measures 0×0,
  // so it reports `visible: false` and the host keeps its timeout running.
  useEffect(() => {
    const probe = () => {
      const box = overlayRef.current?.getBoundingClientRect();
      const visible =
        document.visibilityState !== 'hidden' &&
        !!box &&
        box.width > 0 &&
        box.height > 0;
      actions.extensionUiShown(request.id, visible);
      return visible;
    };
    // Layout may still be pending on the first pass; a hidden webview never gets past it (rAF is throttled).
    let raf = 0;
    if (!probe()) raf = requestAnimationFrame(probe);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [request.id]);

  const answer = useCallback(
    (result: UiAnswer) => {
      actions.extensionUiResponse(buildUiResponse(request, result));
      dispatch({ type: 'dismissUi', id: request.id });
    },
    [request, dispatch],
  );
  const cancel = useCallback(() => answer({ kind: 'cancelled' }), [answer]);
  useEscapeKey(cancel);

  const title = dialogTitle(request);
  const queueNote =
    queued > 0
      ? ` · ${queued} more question${queued === 1 ? '' : 's'} after this one`
      : '';

  return createPortal(
    <div className="pp-overlay" ref={overlayRef}>
      <div
        className="pp-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}>
        <div className="pp-head">
          <span className="pp-kicker">pi extension</span>
          <span className="pp-queue">{request.method}</span>
        </div>
        <div className="pp-title">{title}</div>
        <div className="pp-body">
          {request.method === 'select' && (
            <SelectBody request={request} onAnswer={answer} />
          )}
          {(request.method === 'input' || request.method === 'editor') && (
            <TextBody request={request} onAnswer={answer} />
          )}
          {request.method === 'confirm' && (
            <ConfirmBody request={request} onAnswer={answer} />
          )}
        </div>
        <div className="pp-foot">
          <span className="pp-hint">Esc to deny{queueNote}</span>
          {request.method === 'select' && (
            <Button variant="ghost" size="sm" onClick={cancel}>
              Deny
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SelectBody({
  request,
  onAnswer,
}: {
  request: ExtensionUiRequest;
  onAnswer: (answer: UiAnswer) => void;
}) {
  const options = dialogOptions(request);
  const pick = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) onAnswer({ kind: 'value', value: option.value });
    },
    [options, onAnswer],
  );
  const {
    focused,
    setFocused,
    onKeyDown: navKeyDown,
  } = useListNavigation({
    count: options.length,
    onSelect: pick,
  });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The numbered badges are the fast path — pi-gate offers nine choices and the one you want is
    // usually near the end of the list.
    if (/^[1-9]$/.test(e.key)) {
      const index = Number(e.key) - 1;
      if (index < options.length) {
        e.preventDefault();
        pick(index);
        return;
      }
    }
    navKeyDown(e);
  };

  if (options.length === 0) {
    return (
      <div className="pp-empty">
        This dialog offers no options — deny it and answer in the terminal
        instead.
      </div>
    );
  }

  return (
    <div
      className="pp-list"
      ref={listRef}
      tabIndex={-1}
      role="listbox"
      onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={`${index}-${option.label}`}
          type="button"
          role="option"
          aria-selected={index === focused}
          className={`pp-option${index === focused ? ' is-focused' : ''}`}
          title={option.label}
          onMouseEnter={() => setFocused(index)}
          onClick={() => pick(index)}>
          <span className="pp-option-key">{index + 1}</span>
          <span className="pp-option-label">{option.label}</span>
        </button>
      ))}
      <div className="pp-list-hint">
        ↑↓ choose · Enter confirm · 1-{Math.min(options.length, 9)} jump
      </div>
    </div>
  );
}

function TextBody({
  request,
  onAnswer,
}: {
  request: ExtensionUiRequest;
  onAnswer: (answer: UiAnswer) => void;
}) {
  const isEditor = request.method === 'editor';
  const [value, setValue] = useState(() => dialogDraft(request));
  const submit = () => onAnswer({ kind: 'value', value });

  return (
    <div className="pp-form">
      {isEditor ? (
        <textarea
          className="pp-textarea"
          value={value}
          rows={8}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          className="pp-input"
          type="text"
          value={value}
          placeholder={dialogDraft(request) || 'Type your answer…'}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      )}
      <div className="pp-form-actions">
        <Button variant="ghost" onClick={() => onAnswer({ kind: 'cancelled' })}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit}>
          {isEditor ? 'Save' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

function ConfirmBody({
  request,
  onAnswer,
}: {
  request: ExtensionUiRequest;
  onAnswer: (answer: UiAnswer) => void;
}) {
  const message = dialogMessage(request);
  return (
    <div className="pp-form">
      {message && <div className="pp-message">{message}</div>}
      <div className="pp-form-actions">
        <Button
          variant="ghost"
          onClick={() => onAnswer({ kind: 'confirmed', confirmed: false })}>
          No
        </Button>
        <Button
          variant="primary"
          autoFocus
          onClick={() => onAnswer({ kind: 'confirmed', confirmed: true })}>
          Yes
        </Button>
      </div>
    </div>
  );
}
