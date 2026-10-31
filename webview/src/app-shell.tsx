import { useEffect, useState } from 'react';
import type { HostMessage } from '../../shared/protocol';
import { actions } from './apis/actions';
import { onHostMessage } from './apis/vscode';
import { composer } from './stores/composer-store';
import { useSessionInfoStore } from './stores/session-info-store';
import { useChatDispatch, useChatState } from './contexts/chat-context';
import { useEscapeKey } from './hooks/use-escape-key';
import { ChatScreen } from './screens/session-screen';
import { SplashScreen } from './screens/splash-screen';

interface ForkMode {
  entryId: string;
  text: string;
}

/** Handlers for host messages that drive local view state rather than the store. */
type ViewMessageHandlers = {
  [K in HostMessage['type']]?: (
    message: Extract<HostMessage, { type: K }>,
  ) => void;
};

export function Shell() {
  const state = useChatState();
  const dispatch = useChatDispatch();
  const [forkMode, setForkMode] = useState<ForkMode | null>(null);

  useEffect(() => {
    // A few host messages steer view-local UI (focus, drafts, fork mode,
    // attachments); route those here and let everything else fall through to
    // the store so there's a single reducer path for chat state.
    // Draft edits go through the composer store — the textarea's value lives in
    // the composer, which isn't mounted yet while the splash screen is up.
    const handlers: ViewMessageHandlers = {
      focusInput: () => composer.focus(),
      insertText: (message) => {
        composer.insertText(message.text);
        composer.focus();
      },
      enterForkMode: (message) => {
        setForkMode({ entryId: message.entryId, text: message.text });
        composer.setText(message.text);
        composer.focus();
      },
      pickedFiles: (message) =>
        dispatch({ type: 'addPendingAttachments', attachments: message.files }),
    };

    const off = onHostMessage((message: HostMessage) => {
      const handler = handlers[message.type] as
        ((m: HostMessage) => void) | undefined;
      if (handler) handler(message);
      else dispatch({ type: 'host', message });
    });
    actions.ready();
    return off;
  }, []);

  // While an extension dialog is open, Escape answers that question (deny) — it must not also abort the
  // whole run underneath it, which is what the old unconditional binding did. Same for the session-info
  // dialog, whose Escape only closes itself.
  const sessionInfoOpen = useSessionInfoStore((s) => s.open);
  useEscapeKey(
    () => actions.abort(),
    state.streaming && state.pendingUi.length === 0 && !sessionInfoOpen,
  );

  // Stay on the splash until the runtime is actually up. The runtime reports
  // `stopped` before `start()` runs (its initial status), so treating anything
  // other than `starting` as "ready" would flash the empty chat screen during
  // `stopped` before the splash. `starting` and `stopped` are both "coming up"
  // states; only `error` falls through so its (actionable) chat UI stays reachable.
  const phase = state.status.phase;
  if (phase === 'starting' || phase === 'stopped') {
    return <SplashScreen />;
  }

  return (
    <div className="shell">
      <ChatScreen />

      {forkMode && (
        <div className="gh-fork">
          <span>
            ⑂ Editing a previous message — sending will fork the conversation.
          </span>
          <button
            className="ext-link"
            onClick={() => {
              setForkMode(null);
              composer.setText('');
            }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
