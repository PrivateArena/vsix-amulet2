import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { LuArrowUp, LuPaperclip, LuSquare, LuX } from 'react-icons/lu';
import type { Attachment } from '../../../../../shared/protocol';
import { MAX_ATTACHMENT_BYTES } from '../../../../../shared/constants';
import { actions } from '../../../apis/actions';
import { useChatDispatch, useChatState } from '../../../contexts/chat-context';
import { useSlashCommands } from '../../../hooks/use-slash-commands';
import type { SlashCommand } from '../cmd-menu';
import { CommandMenu } from '../cmd-menu';
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
    const localRef = useRef<HTMLTextAreaElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useAutoGrow(localRef, input);
    usePublishComposerHeight(rootRef);

    const setRefs = (el: HTMLTextAreaElement | null) => {
      localRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref)
        (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current =
          el;
    };

    const submit = (text?: string) => {
      const message = (text ?? input).trim();
      if (!message && pendingAttachments.length === 0) return;
      if (streaming) {
        actions.steer(message);
      } else {
        // Leave the attachments in `pendingAttachments`: the store links them to
        // the user message's uid when its `message_start` event arrives, which is
        // what lets the bubble render them.
        actions.sendMessage(
          message,
          pendingAttachments.length > 0 ? pendingAttachments : undefined,
        );
      }
      setInput('');
    };

    const handleSlashSelect = useCallback(
      (command: SlashCommand) => {
        // Handle built-in commands that trigger actions
        switch (command.clean) {
          case 'clear':
            actions.newChat();
            setInput('');
            break;
          case 'compact':
            actions.compact();
            setInput('');
            break;
          case 'login':
            openProviderLogin();
            setInput('');
            break;
          default:
            // For runtime commands, send as text
            submit(`/${command.clean}`);
        }
      },
      [streaming, input],
    );

    const slash = useSlashCommands({
      commands,
      value: input,
      onSelect: handleSlashSelect,
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
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {slash.visible && (
            <CommandMenu
              items={slash.items}
              query={slash.query}
              focused={slash.focused}
              onHover={slash.onHover}
              onSelect={handleSlashSelect}
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
