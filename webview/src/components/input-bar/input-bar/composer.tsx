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
import type { AtTokenRange, FileMention } from '../../../utils/at-mention';
import { useFileMentions } from '../../../hooks/use-file-mentions';
import type { SlashCommand } from '../cmd-menu';
import { CommandMenu } from '../cmd-menu';
import { FileMenu } from '../file-menu';
import { splitPromptChain } from '../../../utils/prompt-chain';
import { commandName, invocationOf } from '../../../utils/slash-command';
import { mentionInsertion } from '../../../utils/at-mention';
import { appendToDraft, toBlockquote } from '../../../utils/composer-quote';
import { openProviderLogin } from '../../../stores/provider-login-store';
import { useRedact } from '../../../stores/privacy-store';
import {
  clearComposerReserve,
  reserveForComposer,
  useComposerReserveStore,
} from '../../../stores/composer-reserve-store';
import { useComposerStore } from '../../../stores/composer-store';
import { IconButton } from '../../ui/button';
import { ContextMeter } from '../ctx-meter';
import { CompactionHistory } from '../compaction-history';
import { ExtensionCommands } from '../extension-commands';
import { ModelPicker } from '../model-picker';
import { ReasoningSelect } from '../reasoning-select';
import { formatByteSize } from '../../../utils/format';
import './input-bar.scss';

/** `pendingCaret` value meaning "wherever the new text ends", i.e. a pasted quote. */
const CARET_AT_END = -1;

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
 * Can the engine size the textarea itself? `field-sizing: content` (Chromium 123+, so any
 * current VS Code webview) grows a field to its content without ever being measured.
 *
 * Measuring is the fallback, not the design: reading `scrollHeight` right after writing a
 * height is a forced layout of the *document*, so every keystroke would wait on the
 * transcript that happens to be on screen — the more messages, the slower the Enter key.
 */
const SIZES_ITSELF =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content');

/**
 * Grow the textarea with its content, one line at a time, up to the `max-height` the
 * stylesheet imposes; past that it scrolls internally. Writing `height:auto` first lets
 * the element shrink back down when lines are deleted.
 *
 * Exactly one layout read per growth — the old `clientHeight` after the write forced a
 * second one. The stylesheet clamps the value we write, and its `overflow-y: auto` shows
 * a scrollbar only once the draft really is taller than the ceiling, which is what that
 * read was there to decide.
 */
function useAutoGrow(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useLayoutEffect(() => {
    if (SIZES_ITSELF) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [textareaRef, value]);
}

/**
 * Keep the transcript's tail clear of this composer, which floats over it — see
 * `stores/composer-reserve-store.ts` for why the write goes to the log element itself.
 *
 * The height comes from the observer's own box: `getBoundingClientRect()` inside the
 * callback is a read after the layout it just reported, and a read like that is only free
 * while nothing is dirty — a textarea that grew in the same frame is dirty.
 */
function usePublishComposerHeight(
  rootRef: React.RefObject<HTMLElement | null>,
) {
  const log = useComposerReserveStore((s) => s.log);
  /** Last height the observer reported, so a transcript that mounts later gets it. */
  const lastHeight = useRef(0);

  useEffect(() => {
    const el = rootRef.current?.closest('.chat-input-wrap') ?? rootRef.current;
    if (!el) return;
    const publish = (height: number) => {
      if (height <= 0) return;
      lastHeight.current = height;
      reserveForComposer(height);
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // The observer already measured it: `getBoundingClientRect()` here would be a read
      // after the layout it just reported, and such a read is only free while nothing is
      // dirty — a textarea that grew in this very frame is dirty. `blockSize` is the
      // border-box height in this horizontal-tb document, i.e. the old rect height.
      const box = entry.borderBoxSize?.[0];
      publish(box ? box.blockSize : el.getBoundingClientRect().height);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearComposerReserve();
    };
  }, [rootRef]);

  // A transcript element that mounts later (a screen switch) starts on the stylesheet's
  // placeholder gap, so hand it the height the observer already reported. The observer
  // does not re-fire: the composer did not change size, only the element to write on.
  useEffect(() => {
    if (log && lastHeight.current) reserveForComposer(lastHeight.current);
  }, [log]);
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
    /** Caret offset to restore after the next render (slash insertion, quoting). */
    const pendingCaret = useRef<number | null>(null);
    /** `start:query` of the completion token the user dismissed with Escape. */
    const [dismissed, setDismissed] = useState<string | null>(null);
    const dismiss = (token: { start: number }, query: string) =>
      setDismissed(`${token.start}:${query}`);

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
      const at = pos === CARET_AT_END ? textarea.value.length : pos;
      textarea.focus();
      textarea.setSelectionRange(at, at);
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
        names.add(commandName(cmd.name));
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
     * A skill keeps pi's namespace (`/skill:name`), which is what its expander
     * matches on. Only the commands this UI executes itself skip the composer
     * entirely, and even those lose just their own token: the rest survives.
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
      const inserted = `${invocationOf(command.name)} `;
      pendingCaret.current = token.start + inserted.length;
      setCaret(pendingCaret.current);
      setInput(input.slice(0, token.start) + inserted + input.slice(token.end));
    };

    const slash = useSlashCommands({
      commands,
      value: input,
      caret,
      onSelect: applySlashCommand,
      onDismiss: dismiss,
    });

    /**
     * Put the picked path where the `@token` was. A directory keeps the caret glued to its
     * trailing slash so the user can descend further; a file gets a space, because the
     * path is finished and the next word is prose. What lands in the draft is exactly the
     * path pi would type into `read` — relative to the directory it works in.
     */
    const applyFileMention = (mention: FileMention, token: AtTokenRange) => {
      const inserted = mentionInsertion(mention);
      pendingCaret.current = token.start + inserted.length;
      setCaret(pendingCaret.current);
      setInput(input.slice(0, token.start) + inserted + input.slice(token.end));
    };

    const files = useFileMentions({
      value: input,
      caret,
      onSelect: applyFileMention,
      onDismiss: dismiss,
    });

    // A dismissed menu stays dismissed for the token it was dismissed on: the hooks
    // recompute visibility from the draft, so without this the next keystroke of the same
    // word would summon it straight back. It must also gate the key handling, or a hidden
    // menu would keep eating Enter.
    const slashKey = slash.token ? `${slash.token.start}:${slash.query}` : '';
    const fileKey = files.token ? `${files.token.start}:${files.query}` : '';
    const showSlash = slash.visible && slashKey !== dismissed;
    const showFiles = files.visible && fileKey !== dismissed;

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
          // Reads the textarea rather than the closure: this registration happens once, so
          // the `input` it captured is forever empty, while the element always holds the
          // draft the user is looking at.
          prefixDraft: (text) => {
            const current = localRef.current?.value ?? '';
            if (current.startsWith(text)) {
              localRef.current?.focus();
              return;
            }
            setInput(text + current);
            // Park the caret after `/name ` so the arguments can be typed straight away.
            pendingCaret.current = text.length;
          },
          quote: (text) => {
            setInput((v) => appendToDraft(v, toBlockquote(text)));
            // Answer the quote right away: land the caret after the pasted block.
            pendingCaret.current = CARET_AT_END;
          },
          setText: (text) => setInput(text),
          focus: () => localRef.current?.focus(),
        }),
      [],
    );

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // First, let a completion menu try to consume the event. The two never fight for
      // one token: a value cannot end in both a `/token` and an `@token`.
      if (showSlash && slash.onKeyDown(e)) return;
      if (showFiles && files.onKeyDown(e)) return;

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
    // A picked file is named the way a path is, so the chip shows the censored name — the attachment
    // itself keeps the real one, and so does the gallery once the message is on its way.
    const redact = useRedact();

    return (
      <div className="input-bar" ref={rootRef}>
        {hasAttachments && (
          <div className="input-attachments">
            {pendingAttachments.map((att) => (
              <div key={att.id} className="attach-chip">
                {att.dataUrl ? (
                  <img
                    src={att.dataUrl}
                    alt={redact(att.name)}
                    className="attach-thumb"
                  />
                ) : (
                  <span className="attach-icon">
                    {att.name.split('.').pop()?.toUpperCase() ?? '?'}
                  </span>
                )}
                <span className="attach-info">
                  <span className="attach-name" title={redact(att.name)}>
                    {redact(att.name)}
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
                  : 'Ask anything, @ for project files, / for commands'
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
          {showSlash && (
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
          {showFiles && (
            <FileMenu
              items={files.items}
              query={files.query}
              focused={files.focused}
              cwd={files.cwd}
              note={files.note}
              hint={files.hint}
              onHover={files.onHover}
              onSelect={(mention) => {
                if (files.token) applyFileMention(mention, files.token);
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
            {/* The compact-history list, right where the meter reports how full the context is. */}
            <CompactionHistory />
            {/* pi's extension commands, for the same reason: they are runtime state, not prose. */}
            <ExtensionCommands />
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
