import { useEffect, useState } from 'react';
import type { HostMessage } from '../../shared/protocol';
import { actions } from './apis/actions';
import { onHostMessage } from './apis/vscode';
import { composer } from './stores/composer-store';
import { contextSurgery } from './stores/context-surgery-store';
import { projectFiles } from './stores/project-files-store';
import { useCompactionHistoryStore } from './stores/compaction-history-store';
import { useContextSurgeryStore } from './stores/context-surgery-store';
import { usePackagesStore } from './stores/packages-store';
import { applyPrivacyConfig } from './stores/privacy-store';
import { applyLineBreakConfig } from './stores/line-breaks-store';
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
      projectFiles: (message) => projectFiles.accept(message.result),
      // Compaction lists and summaries are on demand, so they never enter the transcript.
      compactions: (message) =>
        useCompactionHistoryStore.getState().acceptList(message),
      compactionDetail: (message) =>
        useCompactionHistoryStore
          .getState()
          .acceptDetail(message.id, message.detail),
      // Packages come from settings files, not the wire, so they live with the dialog too.
      packages: (message) => usePackagesStore.getState().acceptList(message),
      packageOpResult: (message) =>
        usePackagesStore.getState().acceptOp(message.result),
      // An edit list is both a badge update (the reducer) and the proof that any operation this panel
      // asked for has landed — which is what releases a card's in-flight mark. The host pushes it after
      // every history snapshot and after every op, so no timer has to guess.
      contextEdits: (message) => {
        contextSurgery.clearInFlight();
        dispatch({ type: 'host', message });
      },
      // The transcript row is the host's `notice`; this is only the panel's way back, and only while the
      // offer is live — a refused revert leaves nothing to undo.
      revertResult: (message) => {
        contextSurgery.setUndoRevert(message.result.ok ? message.result : null);
        dispatch({ type: 'host', message });
      },
      // `config` carries store flags (expandThinking, the censoring rules, the line-break
      // preference) and they are all rendering state rather than chat state: none of them
      // ever enters the transcript, only its painting.
      config: (message) => {
        applyPrivacyConfig(message.config);
        applyLineBreakConfig(message.config);
        dispatch({ type: 'host', message });
      },
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
  // whole run underneath it, which is what the old unconditional binding did. Same for the chat-panel
  // dialogs, whose Escape only closes themselves.
  const sessionInfoOpen = useSessionInfoStore((s) => s.open);
  const compactionOpen = useCompactionHistoryStore((s) => s.openId !== null);
  const packagesOpen = usePackagesStore((s) => s.open);
  useEscapeKey(
    () => actions.abort(),
    state.streaming &&
      state.pendingUi.length === 0 &&
      !sessionInfoOpen &&
      !compactionOpen &&
      !packagesOpen,
  );

  // The revert this panel may still take back. The host owns the truth (`ChatState.lastRevert`, cleared
  // at `agent_settled`); this copy only exists to render the way back, and it expires as soon as a run
  // starts — undoing a rewind after the conversation moved on would strand what the user has written.
  const undoRevert = useContextSurgeryStore((s) => s.undoRevert);
  useEffect(() => {
    if (state.streaming && undoRevert) contextSurgery.setUndoRevert(null);
  }, [state.streaming, undoRevert]);

  // A different session is a different conversation: an undo offer, or a card waiting on an operation,
  // cannot survive the move. The host stops offering it on its side (`lastRevert` is cleared on switch and
  // on new chat); this is the panel forgetting the same thing at the same moment.
  const sessionId = state.session?.sessionId;
  useEffect(() => {
    contextSurgery.clearAll();
  }, [sessionId]);

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

      {undoRevert && (
        <div className="gh-fork">
          <span>
            {`Conversation rewound — ${undoRevert.abandonedCount} later ${
              undoRevert.abandonedCount === 1 ? 'entry is' : 'entries are'
            } out of the context.`}
          </span>
          <button
            className="ext-link"
            onClick={() => {
              contextSurgery.setUndoRevert(null);
              actions.undoRevert();
            }}>
            Undo revert
          </button>
          <button
            className="ext-link"
            onClick={() => contextSurgery.setUndoRevert(null)}>
            Keep it this way
          </button>
        </div>
      )}
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
