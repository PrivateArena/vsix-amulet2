import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LuArrowUp, LuPaperclip, LuSquare, LuX } from 'react-icons/lu';
import type { Attachment } from '../../../../../shared/protocol';
import { MAX_ATTACHMENT_BYTES } from '../../../../../shared/constants';
import { actions } from '../../../apis/actions';
import { useChatDispatch, useChatState } from '../../../contexts/chat-context';
import type { SlashTokenRange } from '../../../hooks/use-slash-commands';
import { useSlashCommands } from '../../../hooks/use-slash-commands';
import type { SlashCommand } from '../cmd-menu';
import { CommandMenu } from '../cmd-menu';
import { splitPromptChain } from '../../../utils/prompt-chain';
import { openProviderLogin } from '../../../stores/provider-login-store';
import { useComposerStore } from '../../../stores/composer-store';
import { IconButton } from '../../ui/button';
import { ContextMeter } from '../ctx-meter';
import { ModelPicker } from '../model-picker';
import { ReasoningSelect } from '../reasoning-select';
import { formatByteSize } from '../../../utils/format';
import './input-bar.scss';

/** Read a clipboard image blob into an Attachment (base64 data + data URL). */
function imageToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const ext = file.type.split('/')[1] || 'png';
      resolve({
        id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: file.name || `pasted-${Date.now().toString(36)}.${ext}`,
        mimeType: file.type || 'image/png',
        data: base64,
        dataUrl,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Grow the textarea with its content, one line at a time, up to the `max-height`
 * the stylesheet imposes; past that it scrolls internally. Writing `height:auto`
 * first lets the element shrink back down when lines are deleted.
 */
function useAutoGrow(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const content = textarea.scrollHeight;
    textarea.style.height = `${content}px`;
    // `clientHeight` honours the CSS cap, so this is "did we hit the ceiling?".
    textarea.style.overflowY =
      content > textarea.clientHeight ? 'auto' : 'hidden';
  }, [textareaRef, value]);
}

/**
 * Publish the composer's outer height as `--chat-composer-h` so the message list
 * can reserve exactly that much scroll padding — the composer floats over the
 * log, and a fixed gap would either clip the last reply or waste screen space
 * while the composer is a single line.
 */
function usePublishComposerHeight(
  rootRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const el = rootRef.current?.closest('.chat-input-wrap') ?? rootRef.current;
    if (!el) return;
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--chat-composer-h', `${h}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--chat-composer-h');
    };
  }, [rootRef]);
}

export const InputBar = forwardRef<HTMLTextAreaElement, {}>(
  function InputBar(_props, ref) {
    const { streaming, status, commands, pendingAttachments } = useChatState();
    const dispatch = useChatDispatch();
    const ready = status.phase === 'ready';

    const [input, setInput] = useState('');
    /** Live caret offset — the menu completes only the token under the caret. */
    const [caret, setCaret] = useState(0);
    const localRef = useRef<HTMLTextAreaElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    /** Caret offset to restore after the next render (slash insertion). */
    const pendingCaret = useRef<number | null>(null);

    useAutoGrow(localRef, input);
    usePublishComposerHeight(rootRef);

    // Re-apply the caret after a command was inserted — React only restores the
    // selection when the value changed as a side effect of typing.
    useLayoutEffect(() => {
      const pos = pendingCaret.current;
      if (pos === null) return;
      pendingCaret.current = null;
      const textarea = localRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    }, [input]);

    const setRefs = (el: HTMLTextAreaElement | null) => {
      localRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref)
        (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current =
          el;
    };

    /**
     * Commands the runtime expands from message text — prompt templates and
     * skills. Extension commands are excluded: they execute immediately and
     * cannot be queued as a follow-up.
     */
    const chainableNames = useMemo(() => {
      const names = new Set<string>();
      for (const cmd of commands) {
        if (cmd.source === 'extension') continue;
        names.add(cmd.name.replace(/^\/+/, ''));
      }
      return names;
    }, [commands]);

    const submit = () => {
      const message = input.trim();
      if (!message && pendingAttachments.length === 0) return;
      // One `/command` per prompt: the runtime expands only the leading command,
      // so a chained entry is split and the tail queues behind the first run.
      const parts = splitPromptChain(message, (name) =>
        chainableNames.has(name),
      );
      const followUps = parts.length > 1 ? parts.slice(1) : undefined;
      const text = parts[0] ?? message;
      if (streaming) {
        actions.steer(text, followUps);
      } else {
        // Leave the attachments in `pendingAttachments`: the store links them to
        // the user message's uid when its `message_start` event arrives, which is
        // what lets the bubble render them.
        actions.sendMessage(
          text,
          pendingAttachments.length > 0 ? pendingAttachments : undefined,
          followUps,
        );
      }
      setInput('');
    };

    /**
     * Drop the in-progress `/token` and put the invocation in its place, leaving
     * the caret after `/name ` so arguments — or another `/command` — can follow.
     * Only the commands this UI executes itself skip the composer entirely, and
     * even those lose just their own token: the rest of the draft survives.
     */
    const applySlashCommand = (
      command: SlashCommand,
      token: SlashTokenRange,
    ) => {
      const restOfDraft = () =>
        (input.slice(0, token.start) + input.slice(token.end)).trim();
      switch (command.clean) {
        case 'clear':
          actions.newChat();
          setInput(restOfDraft());
          return;
        case 'compact':
          actions.compact();
          setInput(restOfDraft());
          return;
        case 'login':
          openProviderLogin();
          setInput(restOfDraft());
          return;
      }
      const inserted = `/${command.clean} `;
      pendingCaret.current = token.start + inserted.length;
      setCaret(pendingCaret.current);
      setInput(input.slice(0, token.start) + inserted + input.slice(token.end));
    };

    const slash = useSlashCommands({
      commands,
      value: input,
      caret,
      onSelect: applySlashCommand,
    });

    // Request commands from the host on mount
    useEffect(() => {
      actions.requestCommands?.();
    }, []);

    // Publish the draft handle so host commands can drive this textarea. The
    // draft lives here, so without this the shell's handlers have nothing to
    // write to. Registering flushes anything the host sent before we mounted.
    useEffect(
      () =>
        useComposerStore.getState().register({
          insertText: (text) =>
            setInput((v) => (v && !v.endsWith(' ') ? `${v} ` : v) + text),
          setText: (text) => setInput(text),
          focus: () => localRef.current?.focus(),
        }),
      [],
    );

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // First, let the slash command handler try to consume the event
      if (slash.onKeyDown(e)) return;

      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        submit();
      }
    };

    const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) images.push(file);
        }
      }
      // No image in the clipboard — let the textarea paste text as usual.
      if (images.length === 0) return;

      e.preventDefault();
      const accepted = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
      if (accepted.length === 0) return;
      void Promise.all(accepted.map(imageToAttachment))
        .then((attachments) =>
          dispatch({ type: 'addPendingAttachments', attachments }),
        )
        .catch(() => {
          /* unreadable clipboard blob — nothing to attach */
        });
    };

    const removeAttachment = useCallback(
      (id: string) => {
        dispatch({
          type: 'setPendingAttachments',
          attachments: pendingAttachments.filter((a) => a.id !== id),
        });
      },
      [pendingAttachments, dispatch],
    );

    const hasAttachments = pendingAttachments.length > 0;

    return (
      <div className="input-bar" ref={rootRef}>
        {hasAttachments && (
          <div className="input-attachments">
            {pendingAttachments.map((att) => (
              <div key={att.id} className="attach-chip">
                {att.dataUrl ? (
                  <img
                    src={att.dataUrl}
                    alt={att.name}
                    className="attach-thumb"
                  />
                ) : (
                  <span className="attach-icon">
                    {att.name.split('.').pop()?.toUpperCase() ?? '?'}
                  </span>
                )}
                <span className="attach-info">
                  <span className="attach-name" title={att.name}>
                    {att.name}
                  </span>
                  <span className="attach-size">
                    {formatByteSize(att.size)}
                  </span>
                </span>
                <button
                  className="attach-remove"
                  onClick={() => removeAttachment(att.id)}
                  title="Remove">
                  <LuX size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`input-wrap${hasAttachments ? ' has-attachments' : ''}`}>
          <textarea
            ref={setRefs}
            className="input-field"
            placeholder={
              !ready
                ? 'Waiting for runtime…'
                : streaming
                  ? 'Steer the agent (Esc to stop)…'
                  : 'Ask anything, @ to add files, / for commands'
            }
            rows={1}
            disabled={!ready}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            // A caret move without a value change never re-renders the textarea,
            // so the menu must observe it to know which token it completes.
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {slash.visible && (
            <CommandMenu
              items={slash.items}
              query={slash.query}
              focused={slash.focused}
              onHover={slash.onHover}
              onSelect={(command) => {
                if (slash.token) applySlashCommand(command, slash.token);
              }}
              textareaRef={localRef}
            />
          )}
        </div>
        <div className="input-toolbar">
          <div className="input-toolbar-group">
            <IconButton
              size="sm"
              variant="ghost"
              icon={LuPaperclip}
              label="Attach files"
              tooltip="Attach files"
              onClick={() => actions.pickFiles()}
            />
            <ContextMeter />
            <span className="toolbar-hide-narrow">
              <ModelPicker />
            </span>
            <span className="toolbar-hide-narrow">
              <ReasoningSelect />
            </span>
          </div>
          <div className="input-toolbar-group">
            {streaming ? (
              <IconButton
                size="sm"
                variant="error"
                icon={LuSquare}
                label="Stop"
                tooltip="Stop (Esc)"
                onClick={() => actions.abort()}
              />
            ) : (
              <IconButton
                size="sm"
                variant="contained"
                icon={LuArrowUp}
                label="Send (Enter)"
                disabled={!ready || (!input.trim() && !hasAttachments)}
                onClick={() => submit()}
              />
            )}
          </div>
        </div>
      </div>
    );
  },
);
