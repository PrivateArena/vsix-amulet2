import type {
  Attachment,
  ExtensionUiResponse,
  PackageScope,
  ProviderLoginRequest,
  ThinkingLevel,
} from '../../../shared/protocol';
import { postMessage } from './vscode';

/**
 * Semantic wrappers over the raw host `postMessage` channel.
 *
 * Any component can import `actions` directly instead of receiving a callback
 * prop from `App`. This removes the need to thread `onStop`, `onSelectModel`,
 * `onCompact`, `onNewChat`, etc. down the tree.
 */
export const actions = {
  ready: () => postMessage({ type: 'ready' }),

  // conversation
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    followUps?: string[],
  ) => postMessage({ type: 'sendMessage', text, attachments, followUps }),
  pickFiles: () => postMessage({ type: 'pickFiles' }),
  /**
   * Fetch the bytes behind one image a tool returned, and open it full size. Both are
   * keyed by the path the call named; the host resolves it against the runtime's cwd and
   * types it by the file's own signature.
   */
  loadToolImage: (toolCallId: string, index: number, path: string) =>
    postMessage({ type: 'loadToolImage', toolCallId, index, path }),
  openToolImage: (toolCallId: string, path: string) =>
    postMessage({ type: 'openToolImage', toolCallId, path }),
  steer: (text: string, followUps?: string[]) =>
    postMessage({ type: 'steer', text, followUps }),
  abort: () => postMessage({ type: 'abort' }),
  compact: () => postMessage({ type: 'compact' }),
  editAndFork: (entryId: string, text: string) =>
    postMessage({ type: 'editAndFork', entryId, text }),
  // context surgery — the three edit operations all address a **tool call id**, the id a card already
  // has; the bridge resolves it to pi's session entries. They change what the *model* re-reads on the
  // next request, never the transcript, the session file or the text handed back to pi. None of them
  // answers a reply message: the result arrives as a `contextEdits` push (the badge list), so a caller
  // marks its row in flight and waits for that list — see `stores/context-surgery-store.ts`.
  /** Stop sending this call's output to the model; the card keeps showing it. */
  omitFromContext: (toolCallId: string) =>
    postMessage({ type: 'omitFromContext', toolCallId }),
  /** Replace the text the model reads for this call, for all future requests. */
  replaceContextContent: (toolCallId: string, content: string) =>
    postMessage({ type: 'replaceContextContent', toolCallId, content }),
  /** Undo an omission or a replacement: the model reads the original again. */
  restoreContextEntry: (toolCallId: string) =>
    postMessage({ type: 'restoreContextEntry', toolCallId }),
  /**
   * Rewind the conversation to one user message: everything after it leaves the context. Same session
   * file, unlike a fork — which is what keeps this a different action from `forkFromMessage`.
   * `occurrence` picks which copy of a repeated text is meant; the host resolves newest when absent.
   */
  revertToMessage: (text: string, occurrence?: 'newest' | number) =>
    postMessage({ type: 'revertToMessage', text, occurrence }),
  /** Go back to the leaf the last successful revert abandoned. */
  undoRevert: () => postMessage({ type: 'undoRevert' }),

  // model / thinking config
  setModel: (provider: string, modelId: string) =>
    postMessage({ type: 'setModel', provider, modelId }),
  requestModels: () => postMessage({ type: 'requestModels' }),
  setThinkingLevel: (level: ThinkingLevel) =>
    postMessage({ type: 'setThinkingLevel', level }),
  requestThinkingLevels: () => postMessage({ type: 'requestThinkingLevels' }),
  setAutoCompaction: (enabled: boolean) =>
    postMessage({ type: 'setAutoCompaction', enabled }),
  setExpandThinking: (enabled: boolean) =>
    postMessage({ type: 'setExpandThinking', enabled }),
  setPrivacyMode: (enabled: boolean) =>
    postMessage({ type: 'setPrivacyMode', enabled }),
  setPreserveLineBreaks: (enabled: boolean) =>
    postMessage({ type: 'setPreserveLineBreaks', enabled }),

  // sessions
  newChat: () => postMessage({ type: 'newChat' }),
  switchSession: (path: string) => postMessage({ type: 'switchSession', path }),
  deleteSession: (path: string) => postMessage({ type: 'deleteSession', path }),
  deleteAllSessions: () => postMessage({ type: 'deleteAllSessions' }),
  renameSession: (path: string, name: string) =>
    postMessage({ type: 'renameSession', path, name }),
  openSessionInEditor: (path: string) =>
    postMessage({ type: 'openSessionInEditor', path }),
  requestSessions: () => postMessage({ type: 'requestSessions' }),
  requestCommands: () => postMessage({ type: 'requestCommands' }),
  /**
   * Ask for the project's file paths to complete an `@`-mention. The caller owns the id
   * and only accepts the answer that carries it, so a listing that arrives late — after a
   * newer request or a restart that changed the working directory — cannot be applied.
   */
  requestProjectFiles: (requestId: number, force?: boolean) =>
    postMessage({ type: 'requestProjectFiles', requestId, force }),
  /** Ask the host for a fresh `get_session_stats` push (`stats` HostMessage). */
  requestStats: () => postMessage({ type: 'requestStats' }),
  /** Ask the host for a fresh `get_state` push (`state` HostMessage). */
  requestState: () => postMessage({ type: 'requestState' }),
  /**
   * Ask for the loaded session's compaction list (`compactions` HostMessage). The caller owns the
   * id and only accepts the answer that carries it, so a list that lands after a session switch
   * cannot be drawn as the new session's history.
   */
  requestCompactions: (requestId: number) =>
    postMessage({ type: 'requestCompactions', requestId }),
  /** Ask for one boundary's summary text (`compactionDetail` HostMessage), by entry id. */
  requestCompactionDetail: (id: string) =>
    postMessage({ type: 'requestCompactionDetail', id }),
  openForkPicker: () => postMessage({ type: 'openForkPicker' }),
  forkFromMessage: (text: string) =>
    postMessage({ type: 'forkFromMessage', text }),
  openInEditor: () => postMessage({ type: 'openInEditor' }),

  // info menu
  exportChat: () => postMessage({ type: 'exportChat' }),
  restart: () => postMessage({ type: 'restart' }),
  openPiFolder: () => postMessage({ type: 'openPiFolder' }),
  updatePi: () => postMessage({ type: 'updatePi' }),
  openSettings: () => postMessage({ type: 'openSettings' }),
  openExternal: (url: string) => postMessage({ type: 'openExternal', url }),
  copyText: (text: string) => postMessage({ type: 'copyText', text }),

  // pi packages
  /**
   * Ask for the configured pi packages (`packages` HostMessage). The caller owns the id and only
   * accepts the answer that carries it, so a listing that lands after the settings files moved — or
   * after a folder switch changed the project file — cannot be drawn as the other one's.
   */
  requestPackages: (requestId: number) =>
    postMessage({ type: 'requestPackages', requestId }),
  installPackage: (opId: number, source: string, scope: PackageScope) =>
    postMessage({ type: 'installPackage', opId, source, scope }),
  removePackage: (opId: number, source: string, scope: PackageScope) =>
    postMessage({ type: 'removePackage', opId, source, scope }),
  setPackageEnabled: (
    opId: number,
    source: string,
    index: number,
    scope: PackageScope,
    enabled: boolean,
  ) =>
    postMessage({
      type: 'setPackageEnabled',
      opId,
      source,
      index,
      scope,
      enabled,
    }),
  cancelPackageOperation: () => postMessage({ type: 'cancelPackageOperation' }),
  /** Restart the pi runtimes so they load the declarations the settings files now hold. */
  reloadPackages: (opId: number) =>
    postMessage({ type: 'reloadPackages', opId }),

  // provider login / auth.json
  requestAuthStatus: () => postMessage({ type: 'requestAuthStatus' }),
  openAuthFile: () => postMessage({ type: 'openAuthFile' }),
  providerLogin: (request: ProviderLoginRequest) =>
    postMessage({ type: 'providerLogin', request }),

  // dialogs
  extensionUiResponse: (response: ExtensionUiResponse) =>
    postMessage({ type: 'extensionUiResponse', response }),
  /** Report whether this webview really painted the dialog (see `extensionUiShown`). */
  extensionUiShown: (id: string, visible: boolean) =>
    postMessage({ type: 'extensionUiShown', id, visible }),
};
