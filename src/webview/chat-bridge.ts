import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BridgeTargetView } from '../../shared/bridge-protocol';
import type {
  Attachment,
  CompactionEndEvent,
  CompactionStartEvent,
  ContextEditView,
  ExtensionUiRequest,
  HistoryMessage,
  HostMessage,
  PackageScope,
  ProviderLoginRequest,
  PromptDisposition,
  RevertResult,
  RpcEvent,
  RuntimeStatus,
  SessionStats,
  ThinkingLevel,
  WebviewMessage,
} from '../../shared/protocol';
import { MAX_ATTACHMENT_BYTES } from '../../shared/constants';
import { parseCommandInvocation } from '../../shared/command-invocation';
import {
  compactionBoundaryList,
  compactionDetailOf,
  stripCompactionBoundaries,
} from '../../shared/session-entries';
import { FALLBACK_THINKING_LEVELS } from '../../shared/protocol';
import {
  stripEventImages,
  stripHistoryImagePayloads,
} from '../../shared/blocks';
import { authFilePath, readAuthStatus, writeAuthEntry } from '../auth-store';
import {
  readPromptResource,
  type PromptResourceResult,
} from '../prompts/prompt-resource';
import {
  EXPAND_THINKING_KEY,
  PRIVACY_KEYS,
  PRESERVE_LINE_BREAKS_KEY,
  NOTIFY_STICKY_KEY,
  THINKING_LEVEL_KEY,
  affectsSetting,
  readConfig,
  setExpandThinking,
  setNotifySticky,
  setPrivacyMode,
  setPreserveLineBreaks,
  webviewConfig,
} from '../config';
import type { Logger, PiRuntime } from '../runtime/pi-runtime';
import {
  getAgentVersion,
  resolveAgentDir,
  resolveBinaryPath,
} from '../runtime/bootstrap';
import {
  approvalRequested,
  approvalSettled,
  watchRuntime,
} from '../notify/notify-service';
import { PI_UPDATE_ARGS, updatePi } from '../runtime/pi-updater';
import {
  beginPackageCommand,
  listPackages,
  packagesFingerprintOf,
  runPackageCommand,
  togglePackage,
} from '../packages/package-service';
import type { PackageDirs } from '../packages/package-catalog';
import type { SessionManager } from '../session/session-manager';
import {
  listSessions,
  readBranchCompactions,
  readBranchContextEdits,
  sessionsDirForCwd,
  type ContextEditRecord,
} from '../session/session-store';
import { handleExtensionUiRequest, isBridgeAck } from './extension-ui';
import { appliedEdits } from './context-edit-views';
import { restoreOmittedToolResults } from './history-repair';
import { BridgeClient } from './bridge-client';
import { listProjectFiles } from './project-files';
import {
  isSupportedImage,
  readToolImage,
  resolveToolImagePath,
} from './tool-image';
import {
  ackUiRequest,
  answerUiRequest,
  armUiRequest,
  beginUiRequest,
  isModalUiMethod,
  isUserVisibleUiMethod,
  type DialogDeps,
} from './ui-request-routing';
import {
  countSurfacesShowing,
  dismissUiRequest,
  registerUiSurface,
  showUiRequest,
  type UiSurface,
} from './ui-surfaces';

/** Ceiling for the post-update runtime reload, so its result toast always shows. */
const PI_RELOAD_TIMEOUT_MS = 30_000;

/**
 * Events that put something in the transcript, so a command that emitted one was not silent.
 * Deliberately narrow: `queue_update` and friends are bookkeeping the human never reads.
 */
const VISIBLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent_start',
  'message_start',
  'tool_execution_start',
  'compaction_start',
]);

/**
 * How long to wait after an extension command reports `handled` before concluding it produced
 * nothing. A handler may `notify` without awaiting it, so a toast can land just after the
 * response — and a notice about silence that arrives beside a toast would be a lie.
 */
const SILENT_COMMAND_GRACE_MS = 400;

export interface ChatBridgeOptions {
  /** Human-readable surface name in the output-channel log (`sidebar`, `editor`). */
  surfaceLabel: string;
  /**
   * Whether VS Code reports the bound webview as on screen (`WebviewView.visible`). Logged as a hint only:
   * dialog routing uses the webview's own layout ack, because this flag is unreliable across versions.
   */
  isVisible: () => boolean;
  /**
   * When true, the first connect opens on a fresh session instead of resuming
   * the active one. Non-destructive: any prior conversation is kept in session
   * history (it just isn't auto-resumed). Used by the sidebar so opening the
   * panel always lands on a new chat; the editor panel leaves this off so
   * "Open in editor" mirrors the current conversation.
   */
  openFresh?: boolean;
}

/**
 * Connects one webview surface to the active pi runtime: forwards runtime events
 * and status to the webview, translates webview messages into runtime calls, and
 * surfaces pi extension dialogs in-webview, falling back to VS Code's own dialog
 * when no webview can show one.
 */
export class ChatBridge implements vscode.Disposable {
  private runtime: PiRuntime | null = null;
  private subscriptions: Array<() => void> = [];
  private disposed = false;
  /** Guarded so a runtime that predates the command is asked only once. */
  private thinkingLevelsSupported = true;
  /** Drops levels computed for a superseded call (runtime restart, model switch). */
  private thinkingLevelsSeq = 0;
  /** Guards {@link ChatBridgeOptions.openFresh} so only the first connect starts fresh. */
  private consumedOpenFresh = false;
  /** True while a `pi update` child process is running (the menu is re-entrant). */
  private piUpdateInFlight = false;
  /**
   * Fingerprint of the package declarations the bound runtime loaded, captured when its child started.
   * Comparing a listing against it is what makes "pi is running something else than what the settings
   * say now" visible — including when the edit came from a terminal and not from here.
   */
  private packageBaseline: string | null = null;
  /** Runtime instance {@link packageBaseline} belongs to; a new one has loaded something new. */
  private packageRuntime: PiRuntime | null = null;
  /** Last phase seen from the bound runtime, so a restart is recognisable as the move into `ready`. */
  private lastPhase: RuntimeStatus['phase'] | null = null;
  /** The one `pi install`/`pi remove` child this bridge is waiting on, or null when idle. */
  private packageOp: AbortController | null = null;
  /**
   * Tool-image reads in flight, keyed by call id, position and path. A card asks again
   * whenever state says it has no pixels, so the duplicates are expected — React mounts the
   * webview tree twice in development, and two surfaces read the same file.
   */
  private readonly imageReads = new Set<string>();
  /** extension_ui_request ids this surface is showing and are still awaiting a reply. */
  private readonly forwardedUi = new Set<string>();
  /**
   * Count of `compaction_end` events this bridge has forwarded. A compaction that failed *after*
   * starting always emitted one — and that event is what every surface's transcript card came from —
   * so `runCompact` compares this counter around its own command instead of keeping the last event
   * (whose payload carries the whole summary).
   */
  private compactionEnds = 0;
  /** True while a `compact` command awaits its (post-summarisation) response. */
  private compactInFlight = false;
  /**
   * Count of outputs this bridge has seen that the human can actually read — a dialog, a toast,
   * or a transcript event. {@link submitText} compares it around an extension command to decide
   * whether that command left the chat with nothing to show.
   */
  private visibleOutput = 0;
  /** Undo side of the {@link registerUiSurface} entry made for this bridge. */
  private readonly unregisterSurface: () => void;
  /**
   * The host side of the pi extension Amulet ships (`pi-bridge/`), for this surface alone: it owns the
   * `reqId`s this surface issued, which is what lets one reply be claimed by the caller that waits for
   * it while N surfaces share one runtime. Bound lazily because {@link runtime} moves on `connect()`.
   */
  private readonly bridge: BridgeClient;
  /**
   * What the last successful revert abandoned. Only this run may undo it: once the conversation has
   * moved on, "back to the old leaf" would strand what the user has since written.
   */
  private lastRevert: { revertedFrom: string } | undefined;

  constructor(
    private readonly sessions: SessionManager,
    private readonly log: Logger,
    private readonly post: (message: HostMessage) => void,
    private readonly options: ChatBridgeOptions,
  ) {
    // Field initializers run before parameter properties are assigned under ES2022 class fields,
    // so the registration that reads `this.options` has to happen here.
    this.unregisterSurface = registerUiSurface(this.asUiSurface());
    // ...and the same for a client that has to hold the real logger, not an undefined stand-in.
    this.bridge = new BridgeClient(() => this.runtime, this.log);
  }

  /** This bridge's entry in the dialog surface registry. */
  private asUiSurface(): UiSurface {
    return {
      label: this.options.surfaceLabel,
      hostVisible: () => this.options.isVisible(),
      show: (request, source) => {
        // A dialog may only be shown by a surface bound to the child process that asked for it: an
        // answer sent to another runtime would be ignored and the real question would stay parked.
        if (this.disposed || this.runtime !== source) return false;
        this.forwardedUi.add(request.id);
        this.post({ type: 'extensionUiRequest', request });
        this.log.info(
          `[ui] ${request.method} ${request.id}: posted to ${this.options.surfaceLabel} ` +
            `(host-visible=${this.options.isVisible()})`,
        );
        return true;
      },
      dismiss: (id) => {
        if (!this.forwardedUi.delete(id)) return;
        this.post({ type: 'extensionUiDismiss', id });
      },
      isShowing: (id) => this.forwardedUi.has(id),
    };
  }

  async connect(): Promise<void> {
    this.detach();
    const runtime = this.sessions.getActiveRuntime();
    // A runtime this surface has not seen yet has loaded whatever the files declare now (a child that
    // started before this webview existed is unobservable, and this is the closest honest answer).
    // Deliberately *not* re-captured on every connect: `restart` and a webview reload both reconnect
    // while the same declarations stand, and re-baselining there would hide a real pending change.
    if (this.packageRuntime !== runtime) {
      this.packageRuntime = runtime;
      this.packageBaseline = this.readPackagesFingerprint();
    }
    this.runtime = runtime;
    // Run-finished alerts are installed once per runtime rather than per surface, so a run reports once
    // however many chats are open on it.
    watchRuntime(runtime);

    this.subscriptions.push(
      runtime.onStatus((status) => this.onRuntimeStatus(status)),
    );
    this.subscriptions.push(
      runtime.onEvent((event) => this.onRuntimeEvent(event)),
    );
    this.subscriptions.push(
      runtime.onExtensionUiRequest((req) => void this.onUiRequest(req)),
    );

    // Mirror setting changes made here (or in the Settings editor, or in another
    // panel) into every connected webview.
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        affectsSetting(e, EXPAND_THINKING_KEY) ||
        affectsSetting(e, PRESERVE_LINE_BREAKS_KEY) ||
        affectsSetting(e, NOTIFY_STICKY_KEY) ||
        PRIVACY_KEYS.some((key) => affectsSetting(e, key))
      ) {
        this.postConfig();
      }
      if (affectsSetting(e, THINKING_LEVEL_KEY)) {
        void this.applyThinkingLevelSetting();
      }
    });
    this.subscriptions.push(() => configSub.dispose());

    this.postConfig();
    this.post({ type: 'runtimeStatus', status: runtime.getStatus() });

    try {
      await runtime.start();
      // On the sidebar's first open, start a new session so the panel lands on
      // a clean chat. The previous conversation isn't discarded — it stays in
      // session history — it just isn't resumed. Skip if the active session is
      // already empty so we don't spawn redundant blank sessions.
      if (this.options.openFresh && !this.consumedOpenFresh) {
        this.consumedOpenFresh = true;
        const existing = await runtime.getMessages();
        if (existing.length > 0) await runtime.newSession();
      }
      await this.pushSnapshot();
    } catch {
      // Status already reflects the error.
    }
  }

  private privacyIssuesReported = '';

  /**
   * Forward the view-side settings, naming any censoring rule that had to be dropped: a rule the
   * human wrote and that silently does nothing is how a secret ends up in a screenshot.
   */
  private postConfig(): void {
    const config = webviewConfig();
    const issues = config.privacyRuleIssues ?? [];
    const fingerprint = issues.join('\n');
    // The same settings are pushed on every connect, restart and unrelated toggle, and once per
    // open surface — so a broken rule is named once, not on every echo.
    if (fingerprint && fingerprint !== this.privacyIssuesReported) {
      this.privacyIssuesReported = fingerprint;
      for (const issue of issues) {
        this.log.warn(`amulet.privacyRules — ${issue}`);
      }
    }
    this.post({ type: 'config', config });
  }

  /**
   * Forward a runtime status, and remember what the child loaded on the way in.
   *
   * The move into `ready` is the moment pi read its `settings.json`, so it is the only place the
   * package baseline may be taken. Every attached surface sees the same transition, which is why this
   * is not done in {@link connect}: after "Reload pi" the surfaces that did not ask for the reload
   * would otherwise keep claiming a change that had long been applied.
   */
  private onRuntimeStatus(status: RuntimeStatus): void {
    const previous = this.lastPhase;
    this.lastPhase = status.phase;
    if (status.phase === 'ready' && previous !== 'ready') {
      this.packageBaseline = this.readPackagesFingerprint();
    }
    this.post({ type: 'runtimeStatus', status });
  }

  private onRuntimeEvent(event: { type: string }): void {
    if (VISIBLE_EVENT_TYPES.has(event.type)) this.visibleOutput++;
    // Image payloads are the one part of a tool result no renderer can show, and the
    // one part big enough to matter: redact them, then hand the reference over.
    this.post({
      type: 'rpcEvent',
      event: stripEventImages(event as RpcEvent) as any,
    });
    // Refresh derived data when a turn completes or the session changes. A run is
    // many turns (one LLM call plus its tool results), so `turn_end` is what keeps
    // the context meter moving inside a long run; the reply is derived from
    // already-persisted entries, so it costs one cheap read per LLM call.
    if (
      event.type === 'turn_end' ||
      event.type === 'agent_end' ||
      event.type === 'compaction_end'
    ) {
      void this.pushStats();
    }
    // Compaction is the runtime's own decision as often as it is ours, and `get_session_stats`
    // reports no context usage until the next assistant reply — so log both ends of the span.
    if (event.type === 'compaction_start') {
      this.log.info(
        `Compaction started (reason: ${(event as CompactionStartEvent).reason ?? 'unknown'}).`,
      );
    }
    if (event.type === 'compaction_end') {
      const end = event as CompactionEndEvent;
      this.compactionEnds++;
      const freed =
        end.result && typeof end.result.estimatedTokensAfter === 'number'
          ? ` ${end.result.tokensBefore} -> ~${end.result.estimatedTokensAfter} tokens`
          : '';
      this.log.info(
        end.result
          ? `Compaction done (${end.reason ?? 'unknown'}),${freed}`
          : `Compaction ${end.aborted ? 'cancelled' : `failed: ${end.errorMessage ?? 'unknown error'}`}`,
      );
    }
    // pi has no model-changed wire event, so a level change is our only hint that
    // the model (and with it the capability list) may have moved underneath us.
    if (event.type === 'thinking_level_changed') {
      void this.pushState();
      void this.pushThinkingLevels();
    }
    // A run settling is the last chance a `turn_end` draft had to land, so the badges can move from
    // "the bridge is holding this" to "the session file records this". It is also the end of the undo
    // window: past this point the conversation has been continued, not just paused.
    if (event.type === 'agent_settled') {
      this.lastRevert = undefined;
      void this.pushContextEdits();
    }
  }

  /**
   * Post a history snapshot with the image payloads out of its tool results. A session
   * that read a dozen screenshots persists their bytes in full, and the UI can only ever
   * show one it was asked for — see {@link stripHistoryImagePayloads}.
   *
   * Compaction boundaries come out too: pi projects only the newest one, at the head of the list,
   * which reads as a card that lost its place. Every boundary of the branch is served on demand
   * by `requestCompactions` instead — see {@link pushCompactions}.
   *
   * And a tool result the user omitted is put back: `get_messages` answers with the model-context
   * projection, in which that result no longer exists, so without the repair the card disappears from
   * a transcript the user never deleted. The edit list goes out with it, which is what badges the card
   * (plan F-4).
   */
  private async postHistory(
    messages: HistoryMessage[],
    sessionFile?: string | null,
  ): Promise<void> {
    const file =
      sessionFile === undefined ? await this.sessionFileOf() : sessionFile;
    const edits = await this.contextEdits(file);
    this.post({
      type: 'history',
      messages: stripHistoryImagePayloads(
        restoreOmittedToolResults(stripCompactionBoundaries(messages), edits),
      ),
    });
    this.post({
      type: 'contextEdits',
      edits: this.contextEditViews(file, edits),
    });
  }

  /** The session file the loaded child is writing, or null for a session with no file yet. */
  private async sessionFileOf(): Promise<string | null> {
    try {
      return (await this.runtime?.getState())?.sessionFile ?? null;
    } catch {
      return null;
    }
  }

  /** The durable context edits of one session file, and never a thrown history push. */
  private async contextEdits(
    sessionFile: string | null | undefined,
  ): Promise<ContextEditRecord[]> {
    try {
      return await readBranchContextEdits(sessionFile);
    } catch (err) {
      this.log.warn(
        `Failed to read the context edits: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Re-push the edit list on its own: after an operation the badges move while the transcript itself
   * did not change, and reading the projection again would cost a round trip for nothing.
   */
  private async pushContextEdits(sessionFile?: string | null): Promise<void> {
    const file =
      sessionFile === undefined ? await this.sessionFileOf() : sessionFile;
    this.post({
      type: 'contextEdits',
      edits: this.contextEditViews(file, await this.contextEdits(file)),
    });
  }

  /**
   * The badges to show: what the session file records, plus what this host asked for and pi has not
   * written yet. The merge lives in {@link appliedEdits} rather than in this bridge because N surfaces
   * share one runtime, and every one of them must be able to say the same thing about a card
   * (plan F-5).
   */
  private contextEditViews(
    sessionFile: string | null,
    records: ContextEditRecord[],
  ): ContextEditView[] {
    return appliedEdits.merge(sessionFile, records.map(contextEditViewOf));
  }

  private async pushSnapshot(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      const [models, messages, state] = await Promise.all([
        runtime.getAvailableModels(),
        runtime.getMessages(),
        runtime.getState(),
      ]);
      this.post({ type: 'models', models });
      await this.postHistory(
        messages as HistoryMessage[],
        state.sessionFile ?? null,
      );
      this.post({ type: 'state', state });
      await Promise.all([
        this.pushThinkingLevels(),
        this.pushStats(),
        this.pushCommands(),
        this.pushSessions(),
      ]);
    } catch (err) {
      this.log.warn(
        `Failed to push snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    const runtime = this.runtime;
    try {
      switch (message.type) {
        case 'ready':
          await this.connect();
          return;
        case 'sendMessage': {
          // Separate image attachments (passed via `images` in the RPC) from
          // text-file attachments (inlined into the prompt so the AI can see
          // them). Non-image entries in `images` are ignored by the pi runtime.
          let promptText = message.text;
          const rpcImages: { type: 'image'; data: string; mimeType: string }[] =
            [];
          if (message.attachments) {
            for (const a of message.attachments) {
              if (a.mimeType.startsWith('image/')) {
                rpcImages.push({
                  type: 'image',
                  data: a.data,
                  mimeType: a.mimeType,
                });
              } else {
                // Inline text files into the prompt with a clear header.
                const decoded = Buffer.from(a.data, 'base64').toString('utf8');
                const fence = '```';
                promptText += `\n\n<file path="${a.name}">\n${fence}\n${decoded}\n${fence}\n</file>`;
              }
            }
          }
          if (runtime) {
            await this.submitText(
              runtime,
              promptText,
              'send',
              rpcImages.length > 0 ? rpcImages : undefined,
            );
          }
          return;
        }
        case 'steer':
          if (runtime) await this.submitText(runtime, message.text, 'steer');
          return;
        case 'abort':
          await runtime?.abort();
          return;
        case 'newChat':
          await runtime?.newSession();
          this.post({ type: 'history', messages: [] });
          await this.pushState();
          void this.pushThinkingLevels();
          await Promise.all([this.pushStats(), this.pushSessions()]);
          return;
        case 'setModel':
          await runtime?.setModel(message.provider, message.modelId);
          await this.pushState();
          await this.pushThinkingLevels();
          // The window belongs to the model, so the usage percentage changes with it.
          await this.pushStats();
          return;
        case 'cycleModel':
          await runtime?.cycleModel();
          await this.pushState();
          await this.pushThinkingLevels();
          await this.pushStats();
          return;
        case 'setThinkingLevel':
          await runtime?.setThinkingLevel(message.level);
          await this.pushState();
          return;
        case 'compact':
          await this.runCompact();
          return;
        case 'requestModels': {
          const models = await runtime?.getAvailableModels();
          if (models) this.post({ type: 'models', models });
          return;
        }
        case 'requestThinkingLevels':
          await this.pushThinkingLevels();
          return;
        case 'requestState':
          await this.pushState();
          return;
        case 'requestStats':
          await this.pushStats();
          return;
        case 'requestCompactions':
          await this.pushCompactions(message.requestId);
          return;
        case 'requestCompactionDetail':
          await this.pushCompactionDetail(message.id);
          return;
        case 'requestCommands':
          await this.pushCommands();
          return;
        case 'requestPromptResource':
          await this.pushPromptResource(message.name, message.requestId);
          return;
        case 'requestProjectFiles':
          await this.pushProjectFiles(message.requestId, message.force);
          return;
        case 'requestPackages':
          this.pushPackages(message.requestId);
          return;
        case 'installPackage':
          await this.runPackageCli(
            'install',
            message.source,
            message.scope,
            message.opId,
          );
          return;
        case 'removePackage':
          await this.runPackageCli(
            'remove',
            message.source,
            message.scope,
            message.opId,
          );
          return;
        case 'setPackageEnabled':
          this.setPackageEnabled(
            message.source,
            message.index,
            message.scope,
            message.enabled,
            message.opId,
          );
          return;
        case 'cancelPackageOperation':
          this.packageOp?.abort();
          return;
        case 'reloadPackages':
          this.reloadPackages(message.opId);
          return;
        case 'requestSessions':
          await this.pushSessions();
          return;
        case 'switchSession':
          await this.switchSession(message.path);
          return;
        case 'deleteSession':
          await this.deleteSession(message.path);
          return;
        case 'deleteAllSessions':
          await this.deleteAllSessions();
          return;
        case 'renameSession':
          await this.renameSession(message.path, message.name);
          return;
        case 'openSessionInEditor':
          await this.openSessionInEditor(message.path);
          return;
        case 'openForkPicker':
          await this.openForkPicker();
          return;
        case 'forkFromMessage':
          await this.forkFromMessage(message.text);
          return;
        case 'editAndFork':
          await this.editAndFork(message.entryId, message.text);
          return;
        case 'omitFromContext':
          await this.runContextOp('omit', message.toolCallId);
          return;
        case 'replaceContextContent':
          await this.runContextOp(
            'replace',
            message.toolCallId,
            message.content,
          );
          return;
        case 'restoreContextEntry':
          await this.runContextOp('restore', message.toolCallId);
          return;
        case 'stopToolCall':
          await this.runStopCommand(message.toolCallId, message.note);
          return;
        case 'revertToMessage':
          await this.revertToMessage(message.text, message.occurrence);
          return;
        case 'undoRevert':
          await this.undoRevert();
          return;
        case 'exportChat':
          await this.exportChat();
          return;
        case 'openInEditor':
          await vscode.commands.executeCommand('amulet.openChatInEditor');
          return;
        case 'setAutoCompaction':
          await runtime?.setAutoCompaction(message.enabled);
          await this.pushState();
          return;
        case 'setExpandThinking':
          // Purely a webview rendering preference; `config` is echoed back so the
          // UI reflects the write even if the change event is suppressed.
          await setExpandThinking(message.enabled);
          this.postConfig();
          return;
        case 'setPrivacyMode':
          // Also purely a webview rendering preference, and the same echo: the censoring is
          // decided in the webview, so the runtime is never restarted for it.
          await setPrivacyMode(message.enabled);
          this.postConfig();
          return;
        case 'setPreserveLineBreaks':
          // Same again: how a message is painted, never what it says — the session file and
          // the prompt keep the author's own newlines either way.
          await setPreserveLineBreaks(message.enabled);
          this.postConfig();
          return;
        case 'setNotifySticky':
          // The odd one of these toggles: it changes a host-side alert, not a rendering, but the menu
          // still has to show what it wrote. Nothing is restarted — `notifySettings()` is read again on
          // the next alert, so the echo is for the checkmark and for a Settings-editor change made next
          // door, which arrives through the same watcher above.
          await setNotifySticky(message.enabled);
          this.postConfig();
          return;
        case 'openPiFolder': {
          const dir = path.join(os.homedir(), '.pi');
          if (fs.existsSync(dir)) {
            await vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(dir),
            );
          } else {
            void vscode.window.showWarningMessage(
              `Amulet: Pi folder not found at ${dir}`,
            );
          }
          return;
        }
        case 'openSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:gunir.amulet',
          );
          return;
        case 'restart':
          await runtime?.restart();
          await this.connect();
          return;
        case 'updatePi':
          await this.forceUpdatePi();
          return;
        case 'showLog':
          this.log.show();
          return;
        case 'pickFiles':
          await this.pickFiles();
          return;
        case 'loadToolImage':
          await this.loadToolImage(
            message.toolCallId,
            message.index,
            message.path,
          );
          return;
        case 'openToolImage':
          await this.openToolImage(message.path);
          return;
        case 'openExternal': {
          // SECURITY: the URL originates from assistant markdown output
          // (prompt-influenceable). Restrict to http/https/mailto so a crafted
          // link can't invoke arbitrary OS handlers (file://, vscode://, ...).
          let target: vscode.Uri;
          try {
            target = vscode.Uri.parse(message.url, true);
          } catch {
            return;
          }
          if (
            target.scheme !== 'http' &&
            target.scheme !== 'https' &&
            target.scheme !== 'mailto'
          ) {
            return;
          }
          void vscode.env.openExternal(target);
          return;
        }
        case 'copyText':
          void vscode.env.clipboard.writeText(message.text);
          return;
        case 'requestAuthStatus':
          this.post({
            type: 'authStatus',
            status: readAuthStatus(readConfig().agentDir),
          });
          return;
        case 'openAuthFile': {
          const authPath = authFilePath(readConfig().agentDir);
          if (fs.existsSync(authPath)) {
            await vscode.window.showTextDocument(vscode.Uri.file(authPath));
          } else {
            void vscode.window.showWarningMessage(
              `Amulet: auth.json not found at ${authPath}`,
            );
          }
          return;
        }
        case 'providerLogin':
          await this.providerLogin(message.request);
          return;
        case 'log':
          this.log[message.level](`[webview] ${message.text}`);
          return;
        case 'extensionUiShown':
          // Proof from this webview that it painted the dialog. Only a `visible` ack stops the host from
          // handing the question to VS Code, so record both signals.
          this.log.info(
            `[ui] ${message.id}: ${this.options.surfaceLabel} painted=${message.visible} ` +
              `(host-visible=${this.options.isVisible()})`,
          );
          ackUiRequest(message.id, message.visible);
          return;
        case 'extensionUiResponse':
          // Routed through the dispatcher so the one-answer rule holds across surfaces.
          if (!answerUiRequest(message.response.id, message.response)) {
            this.log.info(
              `[ui] ${message.response.id}: late answer dropped (already answered elsewhere)`,
            );
          }
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log.error(`Command "${message.type}" failed: ${text}`);
      void vscode.window.showErrorMessage(`Amulet: ${text}`);
    }
  }

  // --- Derived data pushes -------------------------------------------------

  /**
   * Compact the context on the webview's behalf.
   *
   * The response only lands after pi's summarisation call finishes — minutes on a full window,
   * which is why {@link LONG_RUNNING_COMMANDS} lifts the response budget for it. The outcome is
   * *not* posted from here: `compaction_end` reaches every surface over the event stream, which
   * is also the only route for the runtime's own threshold/overflow compaction.
   */
  private async runCompact(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    // pi's first act in `compact()` is `abort()`, and the response only lands after the summary,
    // so a second press arrives while the runtime still reports itself as not compacting. It
    // would cancel the compaction the user is waiting on.
    if (this.compactInFlight) {
      this.log.info('Compaction already running; ignoring a second request.');
      return;
    }
    this.compactInFlight = true;
    const startedAt = Date.now();
    const endsBefore = this.compactionEnds;
    try {
      await runtime.compact();
      this.log.info(
        `Compaction finished in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      // Every failure of a compaction that actually started also emits `compaction_end` —
      // "Already compacted" and "Nothing to compact (session too small)" included — and that is
      // what puts the card in every surface's transcript. Only a command that never got one
      // (dead child, wedged transport, exhausted response budget) has no report to lean on.
      if (this.compactionEnds > endsBefore) {
        this.log.info(`Compaction did not produce a summary: ${text}`);
      } else {
        this.log.error(`Compaction failed: ${text}`);
        void vscode.window.showErrorMessage(`Amulet: ${text}`);
      }
    } finally {
      this.compactInFlight = false;
    }
    // Always re-read: `isCompacting` is what clears the live card should an end event ever be
    // lost, and the context meter needs the post-compaction stats.
    await this.pushState();
    await this.pushStats();
  }

  /**
   * The one place that puts a piece of webview text in front of pi.
   *
   * The route matters: pi executes an extension command *only* from `prompt`, and throws
   * on it from `steer`/`follow_up` (`_queueUserInput`, pi dist/core/agent-session.js:1770).
   * So a recognised `/command` always leaves as a prompt — even when the webview asked to
   * queue it, which is what pi's own TUI does with a command typed during a run. The
   * command names come from the runtime's own `get_commands`, never from the webview, so
   * the rule holds however the text arrived.
   */
  private async submitText(
    runtime: PiRuntime,
    text: string,
    route: 'send' | 'steer',
    images?: unknown[],
  ): Promise<PromptDisposition | undefined> {
    if (text.startsWith('/') && runtime.isExtensionCommand(text)) {
      if (route !== 'send') {
        this.log.info(
          `"${text.slice(0, 40)}" sent as a prompt instead of queued: pi runs ` +
            `extension commands immediately and rejects them on the queueing path.`,
        );
      }
      const seenBefore = this.visibleOutput;
      // `longRunning`: pi resolves this response when the command handler *returns*, so a
      // dialog the handler opened parks it for as long as the human takes to answer — the
      // generic 30s budget would fail a command that worked.
      const disposition = await runtime.prompt(text, images, {
        longRunning: true,
      });
      if (disposition === 'handled') {
        // Nothing follows this: no run, so no events, and the extension's own dialogs
        // (if it opened any) are the whole interaction.
        this.log.info(
          `pi handled "${text.slice(0, 40)}" as an extension command (no run started).`,
        );
        await this.reportSilentCommand(runtime, text, seenBefore);
      }
      return disposition;
    }
    if (route === 'steer') {
      await runtime.steer(text);
      return undefined;
    }
    return runtime.prompt(text, images);
  }

  /**
   * Say so when an extension command this chat ran leaves nothing to show.
   *
   * A handled command writes no user message, starts no run and emits no events: everything the
   * human learns comes from the `ctx.ui.*` calls its handler chose. A handler that renders with
   * `ctx.ui.custom()` chose nothing this client could receive — pi resolves that method to
   * `undefined` outside the terminal (`docs/rpc-extension-ui`), which is why the same command
   * works in a TUI and appears to do nothing here. Silence is then indistinguishable from a
   * send that never landed, so the transcript states what happened instead.
   */
  private async reportSilentCommand(
    runtime: PiRuntime,
    text: string,
    seenBefore: number,
  ): Promise<void> {
    await new Promise((resolve) =>
      setTimeout(resolve, SILENT_COMMAND_GRACE_MS),
    );
    // A restart of this folder, or a window that closed, is not ours to comment on any more.
    if (this.disposed || this.runtime !== runtime) return;
    if (this.visibleOutput > seenBefore) return;
    const name = parseCommandInvocation(text)?.name ?? text.slice(1);
    this.log.info(
      `Extension command "/${name}" produced no dialog, toast or transcript event.`,
    );
    this.post({
      type: 'notice',
      text:
        `/${name} ran, but sent nothing this chat can show. An extension that renders ` +
        `with ctx.ui.custom() only appears in pi's terminal.`,
    });
  }

  private async pushState(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      this.post({ type: 'state', state: await runtime.getState() });
    } catch {
      /* ignore */
    }
  }

  /**
   * Push the thinking levels the runtime actually offers for the current model.
   * The list is the harness's, never ours: only a runtime that answers
   * `get_available_thinking_levels` as "unknown command" (pi before 0.81.0) gets the
   * shared preset, and any other failure keeps the list the webview already has.
   */
  private async pushThinkingLevels(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady || !this.thinkingLevelsSupported) return;
    const seq = ++this.thinkingLevelsSeq;
    let levels: ThinkingLevel[];
    try {
      levels = await runtime.getAvailableThinkingLevels();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!/unknown command/i.test(text)) {
        this.log.warn(`Could not read thinking levels: ${text}`);
        return;
      }
      this.thinkingLevelsSupported = false;
      levels = FALLBACK_THINKING_LEVELS;
    }
    const stale = this.disposed || seq !== this.thinkingLevelsSeq;
    if (stale || !levels.length) return;
    this.post({ type: 'thinkingLevels', levels });
  }

  /**
   * Apply a `amulet.thinkingLevel` change to the live runtime. `disabled` cannot be
   * undone mid-session (pi has no "unset" command), so it only takes effect on the
   * next runtime start.
   */
  private async applyThinkingLevelSetting(): Promise<void> {
    const { thinkingLevel } = readConfig();
    if (thinkingLevel === 'disabled' || !this.runtime?.isReady) return;
    try {
      await this.runtime.setThinkingLevel(thinkingLevel);
      await this.pushState();
    } catch (err) {
      this.log.warn(
        `Could not apply thinking level: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async pushStats(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      this.post({
        type: 'stats',
        stats: (await runtime.getSessionStats()) as SessionStats,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Post the session's compaction history — the list behind the compact-history button.
   *
   * Nothing like this crosses the wire with the transcript: `get_messages` projects one boundary
   * and no file lists, so the list is read off the session file, and only when the button is
   * hovered. The summaries stay on disk until {@link pushCompactionDetail} is asked for one.
   */
  private async pushCompactions(requestId: number): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      const sessionFile = (await runtime.getState()).sessionFile ?? null;
      const boundaries = compactionBoundaryList(
        readBranchCompactions(sessionFile),
      );
      this.post({ type: 'compactions', requestId, sessionFile, boundaries });
    } catch (err) {
      this.log.warn(
        `Failed to read the compaction history: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Post one boundary's summary. A boundary that has gone away answers with null. */
  private async pushCompactionDetail(id: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      const sessionFile = (await runtime.getState()).sessionFile ?? null;
      const entry = readBranchCompactions(sessionFile).find((e) => e.id === id);
      this.post({
        type: 'compactionDetail',
        id,
        detail: entry ? compactionDetailOf(entry) : null,
      });
    } catch (err) {
      this.log.warn(
        `Failed to read compaction ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async pushCommands(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    try {
      this.post({ type: 'commands', commands: await runtime.getCommands() });
    } catch {
      /* ignore */
    }
    // `get_commands` is what makes the bridge's command name known, so availability can only be
    // decided after it — which is also why a runtime that loaded the bridge mid-life flips to true
    // here without any restart.
    await this.pushBridgeStatus();
  }

  /**
   * Read one prompt template or skill for the insert dialog (`requestPromptResource`).
   *
   * The webview sends a *name* and never a path: the file is resolved from this runtime's own
   * `get_commands` answer, so a surface can only be shown a file pi itself offered. A cold command
   * cache is fetched once, because an unprimed list must not read as a missing template.
   */
  private async pushPromptResource(
    name: string,
    requestId: number,
  ): Promise<void> {
    const runtime = this.runtime;
    const fail = (error: string): void => {
      this.log.warn(`Prompt resource "${name}": ${error}`);
      this.post({
        type: 'promptResource',
        requestId,
        name,
        resource: null,
        error,
      });
    };
    if (!runtime?.isReady) {
      fail('No ready pi runtime to read a prompt from.');
      return;
    }
    let result: PromptResourceResult;
    try {
      let command = runtime.findCommand(name);
      if (!command) {
        try {
          command = (await runtime.getCommands()).find((c) => c.name === name);
        } catch {
          /* reported below as "no such command", which is what a dead runtime leaves behind */
        }
      }
      result = readPromptResource(command, {
        // Resolved like every other reader of pi's folders: an unset `amulet.agentDir` means
        // `~/.pi/agent`, and a relative one belongs to the child's cwd, not the host's.
        agentDir: resolveAgentDir(readConfig().agentDir, runtime.cwd),
        cwd: runtime.cwd,
      });
    } catch (err) {
      // A throw here would otherwise be toasted and never answered, leaving the dialog waiting.
      result = {
        error: `Reading ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if ('error' in result) {
      fail(result.error);
      return;
    }
    this.post({
      type: 'promptResource',
      requestId,
      name,
      resource: result.resource,
    });
  }

  /**
   * Stop one executing command: the bridge signals the process group pi spawned for that call, and pi reports
   * the call as a failed result while the run goes on.
   *
   * Deliberately *not* routed through {@link bridgeGate}, whose first job is to refuse while a run is active —
   * and a run parked on a hung command is the only state in which this button exists. pi dispatches an
   * extension command immediately even during streaming (`agent-session.js`: "Handle extension commands
   * first"), which is what makes `/amulet` usable here at all; a `steer` would not do, because a steer waits
   * for a turn boundary and the hang is exactly what prevents one.
   *
   * The one refusal this path can need is "this child has no bridge", which is also the honest answer for an
   * old pi, a disabled `amulet.contextEditing` or a missing bundle — and the reason the webview hides the
   * buttons unless the bridge advertised `toolStop`.
   */
  private async runStopCommand(
    toolCallId: string,
    note?: string,
  ): Promise<void> {
    if (!this.runtime?.isReady) {
      void vscode.window.showWarningMessage(
        'Amulet: the pi runtime is not running.',
      );
      return;
    }
    if (!this.bridge.isAvailable()) {
      void vscode.window.showWarningMessage(
        'Amulet: stopping one command needs the Amulet bridge, which "amulet.contextEditing" loads on pi 1.4 or newer.',
      );
      return;
    }
    const reply = await this.bridge.call('stop', {
      // The command text is *not* sent: the bridge recorded it from the same call it is being asked about,
      // and it is the aim of a process kill. Never trust a webview restatement for that — the rule
      // `src/prompts/prompt-resource.ts` applies to paths applies harder here.
      handle: { kind: 'toolCall', toolCallId },
      content: note ?? '',
    });
    if (!reply.ok) {
      void vscode.window.showWarningMessage(`Amulet: ${reply.error}`);
      return;
    }
    const stop = reply.stop;
    this.log.info(
      stop
        ? `Stopped ${stop.toolName} call ${toolCallId}: ${
            stop.signals.join(' then ') || 'already gone'
          } ${stop.group ? 'process group' : 'process'} ${stop.pids.join(', ')} (${stop.matched}).`
        : `Stopped call ${toolCallId}: the bridge confirmed it but named no process.`,
    );
  }

  /**
   * Say which of the context-surgery actions this child can actually honour, so the menu hides what it
   * cannot do rather than failing when the human clicks it (plan F-1).
   */
  private async pushBridgeStatus(): Promise<void> {
    const available = this.bridge.isAvailable();
    this.post({
      type: 'bridgeStatus',
      available,
      capabilities: this.bridge.capabilities(),
    });
    if (!available) return;
    const capabilities = await this.bridge.refreshCapabilities();
    if (!capabilities) return;
    this.post({
      type: 'bridgeStatus',
      available: true,
      capabilities: {
        ...capabilities,
        // The child reports its own capabilities; the version is the host's fact (`pi --version`).
        piVersion:
          capabilities.piVersion ||
          (this.runtime?.getStatus().agentVersion ?? ''),
      },
    });
  }

  /**
   * Answer one `@`-mention listing. Independent of the runtime by design: the paths come
   * from VS Code's file search over the working directory the runtime spawns in, so the
   * composer completes while the runtime is still starting (or after it crashed).
   */
  private async pushProjectFiles(
    requestId: number,
    force?: boolean,
  ): Promise<void> {
    // Resolved twice on purpose: the failure path must still say which directory it tried.
    const cwd = () => this.runtime?.cwd ?? this.sessions.activeCwd();
    try {
      const listing = await listProjectFiles(cwd(), force);
      this.post({
        type: 'projectFiles',
        result: { requestId, cwd: cwd(), ...listing },
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log.warn(`Project file listing failed for ${cwd()}: ${text}`);
      this.post({
        type: 'projectFiles',
        result: {
          requestId,
          cwd: cwd(),
          paths: [],
          truncated: false,
          error: text,
        },
      });
    }
  }

  private async pushSessions(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    try {
      const current = runtime.isReady
        ? (await runtime.getState()).sessionFile
        : undefined;
      const sessions = listSessions(
        readConfig().agentDir,
        runtime.cwd,
        current,
      );
      this.post({ type: 'sessions', sessions });
    } catch (err) {
      this.log.warn(
        `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Session / fork / export --------------------------------------------

  private async switchSession(path: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    // Whatever this surface could still undo belongs to the session it is leaving, not the one it is
    // opening — and an entry id of another file must never be sent into this one.
    this.lastRevert = undefined;
    // SECURITY: confine switch to the sessions dir; the webview is untrusted.
    const resolved = this.assertSessionPath(path);
    if (!resolved) {
      this.log.warn(`Refused to switch session outside sessions dir: ${path}`);
      return;
    }
    if (await this.isCurrentSession(resolved)) {
      // Already loaded. An in-process switch still aborts a running turn and makes pi re-read every
      // prompt source, and the `--session` fallback it degrades to kills the warm child outright —
      // so refresh this surface instead of switching to what is already on screen.
      await this.pushSnapshot();
      return;
    }
    const result = await runtime.switchSession(resolved);
    if (result.cancelled) {
      // Nothing was loaded, but a cancelled switch can have taken a branch summary with it —
      // and `isCompacting` is the only thing that clears a card built from that flag.
      await this.pushState();
      return;
    }
    await this.pushSnapshot();
  }

  /** Whether the given session file is the one the runtime currently has loaded. */
  private async isCurrentSession(sessionPath: string): Promise<boolean> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return false;
    const current = (await runtime.getState()).sessionFile;
    return !!current && path.resolve(current) === path.resolve(sessionPath);
  }

  /** Reset to a fresh session and refresh the webview (used after deleting the active session). */
  private async resetToNewSession(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) {
      await this.pushSessions();
      return;
    }
    await runtime.newSession();
    // A new session is a different conversation: the tail a revert abandoned in the old one is not
    // something this panel may still offer to bring back.
    this.lastRevert = undefined;
    this.post({ type: 'history', messages: [] });
    await this.pushSnapshot();
  }

  /** Resolve a session path only if it lies within the sessions dir; else null. */
  private assertSessionPath(sessionPath: string): string | null {
    const cwd = this.runtime?.cwd ?? this.sessions.activeCwd();
    const dir = path.resolve(sessionsDirForCwd(readConfig().agentDir, cwd));
    const resolved = path.resolve(sessionPath);
    if (resolved === dir || resolved.startsWith(dir + path.sep))
      return resolved;
    return null;
  }

  private async deleteSession(sessionPath: string): Promise<void> {
    // SECURITY: confine deletion to the sessions dir; the webview is untrusted.
    const resolved = this.assertSessionPath(sessionPath);
    if (!resolved) {
      this.log.warn(
        `Refused to delete session outside sessions dir: ${sessionPath}`,
      );
      return;
    }
    const wasCurrent = await this.isCurrentSession(resolved);
    try {
      fs.rmSync(resolved, { force: true });
    } catch (err) {
      this.log.warn(
        `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (wasCurrent) {
      await this.resetToNewSession();
    } else {
      await this.pushSessions();
    }
  }

  private async deleteAllSessions(): Promise<void> {
    const runtime = this.runtime;
    const confirmed = await vscode.window.showWarningMessage(
      'Delete all chat sessions for this workspace? This cannot be undone.',
      { modal: true },
      'Delete All',
    );
    if (confirmed !== 'Delete All') return;
    const cwd = runtime?.cwd ?? this.sessions.activeCwd();
    const dir = sessionsDirForCwd(readConfig().agentDir, cwd);
    try {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.jsonl')) {
            fs.rmSync(path.join(dir, file), { force: true });
          }
        }
      }
    } catch (err) {
      this.log.warn(
        `Failed to delete all sessions: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.resetToNewSession();
  }

  private async renameSession(
    sessionPath: string,
    rawName: string,
  ): Promise<void> {
    // SECURITY: confine rename/append to the sessions dir; the webview is untrusted.
    const resolved = this.assertSessionPath(sessionPath);
    if (!resolved) {
      this.log.warn(
        `Refused to rename session outside sessions dir: ${sessionPath}`,
      );
      return;
    }
    const name = rawName.trim();
    if (await this.isCurrentSession(resolved)) {
      await this.runtime?.setSessionName(name);
      await this.pushState();
    } else {
      this.appendSessionName(resolved, name);
    }
    await this.pushSessions();
  }

  /**
   * Persist a name onto a non-active session by appending a `session_info`
   * metadata line — the same append-only entry pi writes for `set_session_name`.
   * The session store reads the last such entry as the session's name.
   */
  private appendSessionName(sessionPath: string, name: string): void {
    try {
      let leading = '';
      try {
        const existing = fs.readFileSync(sessionPath, 'utf8');
        if (existing.length > 0 && !existing.endsWith('\n')) leading = '\n';
      } catch {
        /* new/unreadable file — append as-is */
      }
      const entry = JSON.stringify({
        type: 'session_info',
        timestamp: new Date().toISOString(),
        name,
      });
      fs.appendFileSync(sessionPath, `${leading}${entry}\n`);
    } catch (err) {
      this.log.warn(
        `Failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async openSessionInEditor(sessionPath: string): Promise<void> {
    await this.switchSession(sessionPath);
    await vscode.commands.executeCommand('amulet.openChatInEditor');
  }

  private async openForkPicker(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    const messages = await runtime.getForkMessages();
    if (messages.length === 0) {
      void vscode.window.showInformationMessage(
        'No earlier messages to edit in this session.',
      );
      return;
    }
    const items = messages
      .map((m) => ({
        label: normalizeEntryText(m.text).slice(0, 80),
        entryId: m.entryId,
        text: m.text,
      }))
      .reverse();
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Edit a previous message (forks the conversation)',
      placeHolder: 'Select a message to edit and resend',
    });
    if (picked) {
      this.post({
        type: 'enterForkMode',
        entryId: picked.entryId,
        text: picked.text,
      });
    }
  }

  /**
   * Branch from one specific user turn. The webview never sees pi's entry ids,
   * so resolve the right-clicked text against the session's forkable entries —
   * newest match wins, since a prompt can appear twice after an earlier fork.
   * Falls back to the quick-pick when nothing matches (e.g. the stored text
   * drifted from what the transcript renders).
   */
  private async forkFromMessage(text: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    const needle = normalizeEntryText(text);
    const messages = await runtime.getForkMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (normalizeEntryText(messages[i].text) !== needle) continue;
      this.post({
        type: 'enterForkMode',
        entryId: messages[i].entryId,
        text: messages[i].text,
      });
      return;
    }
    await this.openForkPicker();
  }

  private async editAndFork(entryId: string, text: string): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    const result = await runtime.fork(entryId);
    if (result.cancelled) {
      // See `switchSession`: a fork cancelled during its branch summary leaves no history push
      // behind, and its `isCompacting`-derived card would otherwise keep counting.
      await this.pushState();
      return;
    }
    // Refresh history to reflect the truncated branch, then send the edited text.
    const messages = await runtime.getMessages();
    await this.postHistory(messages as HistoryMessage[]);
    // A fork starts a new session, which re-resolves the model and its levels.
    void this.pushThinkingLevels();
    await this.submitText(runtime, text, 'send');
  }

  // --- Context surgery: Omit / Edit context content / Revert -------------------

  /**
   * One Omit / Edit / Restore, asked of the bridge and reported back to this surface.
   *
   * Deliberately not routed through {@link submitText}: a button click is not a command the human
   * typed, and the `notify` ack would then be scored as user-visible output (or announced as silence).
   * The answer arrives on {@link BridgeClient.handleNotify}, correlated by reqId, and never reaches the
   * transcript as text.
   */
  private async runContextOp(
    op: 'omit' | 'replace' | 'restore',
    toolCallId: string,
    content?: string,
  ): Promise<void> {
    if (!(await this.bridgeGate())) return;
    const sessionFile = await this.sessionFileOf();
    const reply = await this.bridge.call(
      op,
      content === undefined
        ? { handle: { kind: 'toolCall' as const, toolCallId } }
        : { handle: { kind: 'toolCall' as const, toolCallId }, content },
    );
    if (reply.ok) {
      // The bridge holds the edit in memory from this moment, so the next request already reflects it,
      // and the durable `context_edit` follows at the next turn boundary. No history re-push on purpose:
      // the live card already shows the real output, and the projection has nothing better to say.
      this.rememberAppliedEdit(sessionFile, op, reply.targets, content);
    } else {
      // One-shot: the card says what failed and why, and the next push of the list retires the claim.
      appliedEdits.remember(
        sessionFile,
        {
          // A refused op never named an entry id — the identity that matters is the tool call's.
          entryId: toolCallId,
          toolCallId,
          kind: 'failed',
          originalText: '',
          error: reply.error,
        },
        false,
      );
      void vscode.window.showWarningMessage(`Amulet: ${reply.error}`);
    }
    await this.pushContextEdits(sessionFile);
  }

  /** Remember what left context, per card, until the session file records it. */
  private rememberAppliedEdit(
    sessionFile: string | null,
    op: 'omit' | 'replace' | 'restore',
    targets: BridgeTargetView[] | undefined,
    content?: string,
  ): void {
    const ids: (string | undefined)[] = [];
    for (const target of targets ?? []) {
      ids.push(target.toolCallId);
      // Only a result has a card to badge; the other entries of the group are reported so the human can
      // see what else left context, and the rule behind it.
      if (target.role !== 'toolResult') continue;
      if (op === 'restore') continue;
      appliedEdits.remember(sessionFile, {
        entryId: target.entryId,
        toolCallId: target.toolCallId,
        kind: op === 'replace' ? 'replaced' : 'omitted',
        replacementText: op === 'replace' ? content : undefined,
        // The transcript already holds the real output while the card is alive; after a reload the
        // durable record supplies it again, together with the same badge.
        originalText: '',
      });
    }
    // A restore's success means *no badge*: the model reads the original again, and the durable list
    // deliberately skips a no-op edit, so anything left claiming otherwise would never be corrected.
    if (op === 'restore') appliedEdits.forget(sessionFile, ...ids);
  }

  /**
   * Ready, idle and bridge-loaded, or a refusal the human can read. The bridge checks idleness again on
   * its side: it is the authority, this is only the fast path that keeps a click from looking dead.
   *
   * Every refusal pushes the edit list before returning, because the panel marked this card as waiting
   * when it sent the click and the list is the only thing that releases it — a gate that said "no" only
   * in a toast would leave the card spinning until some unrelated refresh.
   */
  private async bridgeGate(): Promise<boolean> {
    const runtime = this.runtime;
    if (!runtime?.isReady) {
      await this.pushContextEdits();
      return false;
    }
    if (!this.bridge.isAvailable()) {
      this.post({ type: 'bridgeStatus', available: false });
      void vscode.window.showWarningMessage(
        'Amulet: context editing is unavailable here. It needs pi 1.4 or newer with "amulet.contextEditing" on.',
      );
      await this.pushContextEdits();
      return false;
    }
    const state = await runtime.getState().catch(() => undefined);
    if (state?.isStreaming || state?.isCompacting) {
      void vscode.window.showWarningMessage(
        'Amulet: wait for the run to finish — pi can only change the conversation while it is idle.',
      );
      await this.pushContextEdits();
      return false;
    }
    return true;
  }

  /**
   * Rewind the conversation to one user message, keeping the session file (pi's `navigateTree`).
   *
   * The webview has no entry id for a live message, so the text is resolved against
   * `get_fork_messages` — the same idiom "Branch from here" uses, newest match first — and the bridge
   * then moves the leaf. Unlike {@link forkFromMessage} there is no quick-pick fallback: a revert that
   * picked the wrong message would throw away real work.
   */
  private async revertToMessage(
    text: string,
    occurrence?: 'newest' | number,
  ): Promise<void> {
    if (!(await this.bridgeGate())) return;
    const runtime = this.runtime;
    const needle = normalizeEntryText(text);
    const forkable = (await runtime?.getForkMessages().catch(() => [])) ?? [];
    const matches = forkable.filter(
      (m) => normalizeEntryText(m.text) === needle,
    );
    const target =
      typeof occurrence === 'number' ? matches[occurrence] : matches.at(-1);
    if (!target) {
      this.postRevert({
        ok: false,
        revertedFrom: '',
        abandonedCount: 0,
        message: 'Amulet: could not find that message in this session.',
      });
      return;
    }
    await this.runRevert('revert', target.entryId);
  }

  /** Back to the leaf the last revert abandoned — valid until this run settles. */
  private async undoRevert(): Promise<void> {
    const abandoned = this.lastRevert?.revertedFrom;
    if (!abandoned) {
      this.postRevert({
        ok: false,
        revertedFrom: '',
        abandonedCount: 0,
        message:
          'Amulet: nothing to undo — that revert is already part of the conversation.',
      });
      return;
    }
    if (!(await this.bridgeGate())) return;
    await this.runRevert('undo-revert', abandoned);
  }

  private async runRevert(
    op: 'revert' | 'undo-revert',
    entryId: string,
  ): Promise<void> {
    const reply = await this.bridge.call(op, { entryId, summarize: false });
    if (!reply.ok) {
      // Keep the undo target: a refusal changed nothing, so the offer must survive it.
      this.postRevert({
        ok: false,
        revertedFrom: '',
        abandonedCount: 0,
        message: `Amulet: ${reply.error}`,
      });
      return;
    }
    if (op === 'revert') {
      this.lastRevert = reply.revertedFrom
        ? { revertedFrom: reply.revertedFrom }
        : undefined;
    } else {
      this.lastRevert = undefined;
    }
    // Nothing on the wire says the leaf moved — `session_tree` is not an RPC event — so the host
    // re-reads everything it shows (plan F-11).
    await this.pushSnapshot();
    const abandoned = reply.abandonedCount ?? 0;
    this.postRevert({
      ok: true,
      revertedFrom: reply.revertedFrom ?? '',
      abandonedCount: abandoned,
      message:
        op === 'revert'
          ? `Reverted to that message: ${abandoned} later ${abandoned === 1 ? 'entry is' : 'entries are'} out of the conversation.`
          : 'Restored the conversation to where it was before the revert.',
    });
  }

  /** One line of history the human can read, plus the machine-readable answer the panel needs. */
  private postRevert(result: RevertResult): void {
    this.post({ type: 'revertResult', result });
    this.post({ type: 'notice', text: result.message });
  }

  private async exportChat(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime?.isReady) return;
    const { path } = await runtime.exportHtml();
    const uri = vscode.Uri.file(path);
    const open = await vscode.window.showInformationMessage(
      `Chat exported to ${path}`,
      'Open',
      'Reveal',
    );
    if (open === 'Open') void vscode.env.openExternal(uri);
    else if (open === 'Reveal')
      void vscode.commands.executeCommand('revealFileInOS', uri);
  }

  // --- pi self-update -------------------------------------------------------

  /**
   * Force-update the pi install (and its packages) via `pi update --all --force`,
   * then respawn the runtimes so the new code is actually loaded — a running
   * `pi --mode rpc` child keeps executing the bytes it was spawned with.
   */
  private async forceUpdatePi(): Promise<void> {
    if (this.piUpdateInFlight) return;
    const config = readConfig();
    const resolved = resolveBinaryPath(config.binaryPath || 'pi');
    if (!resolved.resolved) {
      void vscode.window.showErrorMessage(
        `Amulet: could not find the pi runtime at "${config.binaryPath}". Set "amulet.binaryPath" to an absolute path to update it.`,
      );
      return;
    }

    const before = getAgentVersion(resolved.command);
    this.piUpdateInFlight = true;
    this.log.info(
      `Updating pi: ${resolved.command} ${PI_UPDATE_ARGS.join(' ')}`,
    );
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Updating pi…',
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() =>
            controller.abort(),
          );
          const update = await updatePi({
            config,
            cwd: this.runtime?.cwd ?? this.sessions.activeCwd(),
            signal: controller.signal,
            onOutput: (line) => {
              this.log.info(`pi update: ${line}`);
              if (line.trim()) progress.report({ message: line.slice(-60) });
            },
          });
          cancellation.dispose();
          return update;
        },
      );

      if (result.cancelled) {
        this.log.warn('pi update cancelled.');
        void vscode.window.showWarningMessage('Amulet: pi update cancelled.');
        return;
      }
      if (!result.ok) {
        this.log.error(
          `pi update failed (exit ${result.exitCode ?? 'spawn error'}):\n${result.output}`,
        );
        const pick = await vscode.window.showErrorMessage(
          `Amulet: pi update failed${result.exitCode === null ? ' — could not run pi' : ` (exit ${result.exitCode})`}.`,
          'Show Log',
        );
        if (pick === 'Show Log') this.log.show();
        return;
      }

      const reload = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'Reloading pi runtime…',
        },
        () => this.reloadPiRuntimes(),
      );
      const after = this.runtime?.getStatus().agentVersion || before;
      const version =
        after && before && after !== before ? `${before} → ${after}` : after;
      const current = version && version === before ? 'up to date' : 'updated';
      const tail =
        reload === 'reloaded'
          ? 'pi runtime reloaded.'
          : reload === 'stale'
            ? 'but the pi runtime did not reload — use "Reload Pi config".'
            : 'but reloading the pi runtime timed out — check the log.';
      const text =
        reload === 'reloaded'
          ? `pi is ${current} (${version}) — ${tail}`
          : `pi update finished (${version}) — ${tail}`;
      this.log.info(`pi update: ${text}`);
      const pick = await vscode.window.showInformationMessage(
        `Amulet: ${text}`,
        ...(reload === 'reloaded'
          ? ['Show Log']
          : ['Retry Reload', 'Show Log']),
      );
      if (pick === 'Retry Reload') {
        await this.runtime?.restart();
        await this.connect();
      } else if (pick === 'Show Log') {
        this.log.show();
      }
    } finally {
      this.piUpdateInFlight = false;
    }
  }

  /**
   * Respawn every runtime on the updated binary, bounded by
   * {@link PI_RELOAD_TIMEOUT_MS} so a wedged startup can never swallow the
   * update-result notification.
   */
  private async reloadPiRuntimes(): Promise<'reloaded' | 'stale' | 'timeout'> {
    const reloaded = (async () => {
      this.sessions.invalidateAgentVersions();
      await this.sessions.restartAll();
      await this.connect();
    })().then(
      () => 'reloaded' as const,
      () => 'stale' as const,
    );
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), PI_RELOAD_TIMEOUT_MS),
    );
    return Promise.race([reloaded, timeout]);
  }

  // --- Pi packages -----------------------------------------------------------

  /** The two directories every package question is about: the agent dir and the runtime's folder. */
  private packageDirs(): PackageDirs {
    return {
      agentDir: readConfig().agentDir,
      cwd: this.runtime?.cwd ?? this.sessions.activeCwd(),
    };
  }

  /** What the settings files declare right now, or null when they cannot be read at all. */
  private readPackagesFingerprint(): string | null {
    try {
      return packagesFingerprintOf(this.packageDirs());
    } catch {
      return null;
    }
  }

  /**
   * Post the configured pi packages.
   *
   * Deliberately not gated on the runtime being ready, unlike the other pushes: a package that broke
   * pi's startup is precisely the one the user needs to be able to disable, and the list is read off
   * disk rather than asked of the child process.
   */
  private pushPackages(requestId: number): void {
    const dirs = this.packageDirs();
    try {
      this.post({
        type: 'packages',
        result: listPackages({
          dirs,
          baseline: this.packageBaseline,
          requestId,
        }),
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log.warn(`Could not list pi packages: ${text}`);
      // Answer anyway: a dialog left spinning is worse than one that says it could not read.
      this.post({
        type: 'packages',
        result: {
          requestId,
          cwd: dirs.cwd,
          userSettingsFile: '',
          projectSettingsFile: '',
          projectTrusted: false,
          packages: [],
          reloadRequired: false,
          errors: [text],
        },
      });
    }
  }

  /** Flip one declaration between loaded and autoload-disabled, in its settings file. */
  private setPackageEnabled(
    source: string,
    index: number,
    scope: PackageScope,
    enabled: boolean,
    opId: number,
  ): void {
    const result = togglePackage({
      dirs: this.packageDirs(),
      source,
      index,
      scope,
      enabled,
      opId,
    });
    if (result.ok) {
      this.log.info(
        `${enabled ? 'Enabled' : 'Disabled'} pi package "${source}" (${scope} scope); a reload is needed to apply it.`,
      );
    } else {
      this.log.warn(
        `Could not change pi package "${source}": ${result.output}`,
      );
    }
    this.post({ type: 'packageOpResult', result });
  }

  /**
   * One `pi install`/`pi remove` child process, with its output in the log channel and its verdict
   * in the dialog. Only one at a time per surface: two npm installs racing in the same managed
   * prefix is how a package tree gets corrupted.
   */
  private async runPackageCli(
    op: 'install' | 'remove',
    source: string,
    scope: PackageScope,
    opId: number,
  ): Promise<void> {
    const refuse = (output: string): void =>
      this.post({
        type: 'packageOpResult',
        result: { op, opId, source, ok: false, exitCode: null, output },
      });

    if (this.packageOp) {
      refuse('Another package operation is still running in this chat.');
      return;
    }

    const config = readConfig();
    const dirs = this.packageDirs();
    // Claim the install roots before spawning anything: a second chat surface (or a second window on
    // the same agent directory) writing the same managed npm prefix is a corrupted package tree.
    const release = beginPackageCommand(dirs);
    if (!release) {
      refuse(
        'Another pi package command is already running for this folder — wait for it to finish.',
      );
      return;
    }

    const controller = new AbortController();
    this.packageOp = controller;
    this.log.info(
      `Running ${op === 'install' ? 'pi install' : 'pi remove'} "${source}" (${scope} scope) in ${dirs.cwd}`,
    );

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title:
            op === 'install'
              ? 'Installing pi package…'
              : 'Removing pi package…',
          cancellable: true,
        },
        async (progress, token) => {
          const cancellation = token.onCancellationRequested(() =>
            controller.abort(),
          );
          const run = await runPackageCommand({
            config,
            dirs,
            op,
            source,
            scope,
            opId,
            signal: controller.signal,
            onOutput: (line) => {
              this.log.info(`pi ${op}: ${line}`);
              if (line.trim()) progress.report({ message: line.slice(-60) });
            },
          });
          cancellation.dispose();
          return run;
        },
      );

      if (result.ok) {
        this.log.info(
          `pi ${op} finished for "${source}" — reload needed to apply.`,
        );
      } else {
        this.log.error(
          `pi ${op} failed for "${source}" (exit ${result.exitCode ?? 'spawn error'}):\n${result.output ?? ''}`,
        );
      }
      this.post({ type: 'packageOpResult', result });
    } finally {
      this.packageOp = null;
      release();
    }
  }

  /** Restart the runtimes so they load what the settings files declare, and report how it went. */
  private async reloadPackages(opId: number): Promise<void> {
    const outcome = await this.reloadPiRuntimes();
    this.post({
      type: 'packageOpResult',
      result: {
        op: 'reload',
        opId,
        source: '',
        ok: outcome === 'reloaded',
        output:
          outcome === 'reloaded'
            ? undefined
            : outcome === 'stale'
              ? 'The pi runtimes did not come back — use "Reload Pi config" or check the log.'
              : 'Reloading the pi runtimes timed out — check the log.',
      },
    });
  }

  // --- Provider login (auth.json) ------------------------------------------

  private async providerLogin(request: ProviderLoginRequest): Promise<void> {
    const agentDir = readConfig().agentDir;

    if (request.kind === 'oauth') {
      // OAuth tokens can't be minted from the webview — hand off to pi's own
      // interactive login, which performs the handshake and writes the token
      // entry to the same auth.json.
      this.launchProviderLoginCli(request);
      return;
    }

    const finish = (ok: boolean, error?: string): void => {
      this.post({
        type: 'providerLoginResult',
        result: {
          providerId: request.providerId,
          providerLabel: request.providerLabel,
          ok,
          error,
        },
      });
    };

    const key = request.apiKey.trim();
    if (!key) {
      finish(false, 'No API key provided.');
      return;
    }

    try {
      const authPath = writeAuthEntry(agentDir, request.providerId, {
        type: 'api_key',
        key,
      });
      this.log.info(`Saved ${request.providerLabel} API key to ${authPath}`);
      this.post({ type: 'authStatus', status: readAuthStatus(agentDir) });

      // Restart only the pi runtime (its event/status subscriptions survive a
      // restart) so it re-reads auth.json — then refresh the model list and
      // state in place. We deliberately avoid connect()/pushSnapshot here: that
      // re-pushes history and resets the whole webview session.
      await this.runtime?.restart();
      if (this.runtime?.isReady) {
        const models = await this.runtime.getAvailableModels();
        this.post({ type: 'models', models });
        await this.pushState();
        void this.pushThinkingLevels();
        finish(true);
      } else {
        finish(
          false,
          this.runtime?.getStatus().message ??
            'Pi failed to restart. Check the log for details.',
        );
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log.error(`providerLogin failed: ${text}`);
      finish(false, text);
      void vscode.window.showErrorMessage(
        `Amulet: could not complete provider login — ${text}`,
      );
    }
  }

  private launchProviderLoginCli(request: ProviderLoginRequest): void {
    // SECURITY: resolve the binary to an absolute path on disk and strip any
    // control chars so a malicious workspace setting can't inject commands
    // via terminal.sendText (newlines would auto-execute).
    const resolved = resolveBinaryPath(readConfig().binaryPath || 'pi');
    if (!resolved.resolved) {
      void vscode.window.showErrorMessage(
        `Amulet: could not find the pi runtime at "${readConfig().binaryPath || 'pi'}". Set "amulet.binaryPath" to an absolute path before signing in.`,
      );
      return;
    }
    const binary = resolved.command.replace(/[\r\n\t]/g, '');
    const terminal = vscode.window.createTerminal({ name: 'pi · login' });
    terminal.show();
    // Pre-typed but NOT executed: the exact `auth` subcommand is pi-version
    // dependent, so the user reviews/runs it. pi's own TUI then drives the
    // OAuth flow and writes the token entry to auth.json.
    terminal.sendText(`"${binary}" auth login`, false);
    const detail =
      request.kind === 'oauth' && request.gheHost
        ? ` (host: ${request.gheHost})`
        : '';
    void vscode.window.showInformationMessage(
      `Amulet: finish signing in to ${request.providerLabel}${detail} in the terminal, then reload Pi.`,
    );
  }

  // --- File attachments ----------------------------------------------------

  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      filters: {
        Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
        Text: [
          'txt',
          'md',
          'json',
          'ts',
          'tsx',
          'js',
          'jsx',
          'py',
          'rb',
          'go',
          'rs',
          'java',
          'c',
          'cpp',
          'h',
          'css',
          'scss',
          'html',
          'xml',
          'yaml',
          'yml',
          'toml',
          'csv',
        ],
        'All Files': ['*'],
      },
    });
    if (!uris || uris.length === 0) return;

    const attachments: Attachment[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        // Skip files larger than the shared attachment cap.
        if (stat.size > MAX_ATTACHMENT_BYTES) {
          void vscode.window.showWarningMessage(
            `Amulet: skipping ${uri.path.split('/').pop()} — file too large (${Math.round(stat.size / 1024 / 1024)} MB).`,
          );
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const ext = uri.path.split('.').pop()?.toLowerCase() ?? '';
        const isImage = [
          'png',
          'jpg',
          'jpeg',
          'gif',
          'webp',
          'bmp',
          'svg',
        ].includes(ext);
        const mimeType = getMimeType(ext, isImage);
        const base64 = Buffer.from(bytes).toString('base64');
        const fileName = uri.path.split('/').pop() ?? 'file';

        attachments.push({
          id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          name: fileName,
          mimeType,
          filePath: uri.fsPath,
          data: base64,
          dataUrl: isImage ? `data:${mimeType};base64,${base64}` : undefined,
          size: stat.size,
        });
      } catch (err) {
        this.log.warn(
          `Failed to read file ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (attachments.length > 0) {
      this.post({ type: 'pickedFiles', files: attachments });
    }
  }

  // --- Tool images ---------------------------------------------------------

  /**
   * Read one image a tool returned, for a card that is actually showing it.
   *
   * {@link onRuntimeEvent} strips these payloads off the wire before the webview ever sees
   * them, so the bytes only move when a reader opens the card — and they come from the file
   * the call named, not from a copy the host would have to keep alive for the session.
   */
  private async loadToolImage(
    toolCallId: string,
    index: number,
    filePath: string,
  ): Promise<void> {
    const key = `${toolCallId}\u0000${index}\u0000${filePath}`;
    if (this.imageReads.has(key)) return;
    this.imageReads.add(key);
    const answer = (
      patch:
        { dataUrl: string; size: number; mimeType: string } | { error: string },
    ) => {
      if (this.disposed) return;
      this.post({
        type: 'toolImage',
        toolCallId,
        index,
        path: filePath,
        ...patch,
      });
    };
    try {
      const result = await readToolImage(filePath, {
        cwd: this.runtime?.cwd ?? this.sessions.activeCwd(),
      });
      if (result.ok) {
        answer({
          mimeType: result.mimeType,
          dataUrl: result.dataUrl,
          size: result.size,
        });
        return;
      }
      this.log.warn(`Tool image unavailable (${filePath}): ${result.error}`);
      answer({ error: result.error });
    } catch (err) {
      // Without this answer the tile would wait forever on a request nobody is making.
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`Tool image read failed (${filePath}): ${message}`);
      answer({ error: message });
    } finally {
      this.imageReads.delete(key);
    }
  }

  /**
   * Show a tool image full size in the workbench's own viewer. Checked against the file's
   * own signature, so a tool result cannot steer the webview into opening arbitrary paths.
   */
  private async openToolImage(filePath: string): Promise<void> {
    const cwd = this.runtime?.cwd ?? this.sessions.activeCwd();
    const resolved = resolveToolImagePath(filePath, cwd);
    if (!resolved || !(await isSupportedImage(resolved))) return;
    void vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.file(resolved),
    );
  }

  // --- Extension UI dialogs ------------------------------------------------

  /**
   * Route one `extension_ui_request` to the human. A modal request is shown on every surface of this
   * runtime and answered once by whoever gets the click first, with a native VS Code dialog as the
   * fallback if no webview proves it painted one. See {@link ui-request-routing}.
   *
   * The two `approval*` deps are that routing's alert pair: claiming a request is what announces it (so N
   * surfaces still produce one notification), and the single-answer slot is what retires it — including
   * when a *different* surface or VS Code's native dialog is the one that answered.
   */
  private async onUiRequest(req: ExtensionUiRequest): Promise<void> {
    // First, before any early return: whatever the routing decides, this request was seen here. A bridge ack
    // is the one exception — it is machine-readable text, and counting it as something the human read would
    // let a concurrent operation silence `reportSilentCommand`'s honest "nothing happened" notice.
    if (
      isUserVisibleUiMethod(req.method) &&
      !(req.method === 'notify' && isBridgeAck(String(req.message ?? '')))
    ) {
      this.visibleOutput++;
    }
    const runtime = this.runtime;
    if (!runtime) return;

    if (!isModalUiMethod(req.method)) {
      // The bridge's ack travels as a notify, so this is the one place that can hand it back to the
      // operation waiting for it — before anything can turn that text into a toast.
      const response = await handleExtensionUiRequest(
        req,
        this.log,
        (message) => this.bridge.handleNotify(message),
      );
      if (response && !this.disposed) runtime.respondToExtensionUi(response);
      return;
    }

    const deps: DialogDeps = {
      fallbackToNative: (request) =>
        handleExtensionUiRequest(request, this.log, (message) =>
          this.bridge.handleNotify(message),
        ),
      respond: (response) => {
        // Deliberately *not* gated on `disposed`: `dispose()` cancels the dialogs this surface was showing,
        // and pi has to hear that or the tool call stays parked behind a question nobody can answer. The
        // request belongs to the runtime captured here, and an answer it no longer waits for is dropped.
        runtime.respondToExtensionUi(response);
      },
      dismiss: dismissUiRequest,
      log: (text) => this.log.info(text),
      // The alert's other half: whoever answers — this surface, another one, VS Code's own dialog — is
      // what retires the "waiting for you" entry, so no dialog can leave it standing.
      onSettled: (request) => approvalSettled(request.id),
    };
    // Every bridge receives the request; the first one to claim it orchestrates for all of them, and
    // claiming is therefore also what decides that exactly one bridge notifies for a dialog.
    if (!beginUiRequest(req, deps)) return;
    const shown = showUiRequest(req, runtime);
    armUiRequest(req.id, shown);
    // Arming first: with no surface to paint it, the question has already gone to VS Code's own modal
    // dialog by the time this runs — and that dialog is just as invisible to a user in another
    // application, so it is worth alerting for too.
    approvalRequested(req, runtime.cwd);
  }

  private detach(): void {
    for (const unsub of this.subscriptions) unsub();
    this.subscriptions = [];
    // `connect()` calls this first, so this also runs when the surface moves to another runtime: a call
    // waiting on the child we are leaving would never be answered by the one we are getting.
    this.bridge.cancelOutstanding(
      'The chat reconnected before the bridge answered.',
    );
  }

  dispose(): void {
    this.disposed = true;
    // Any bridge call still waiting for an ack belongs to a webview that is gone.
    this.bridge.dispose();
    // A package install/remove still running belongs to a webview that is gone; its output had
    // exactly one reader.
    this.packageOp?.abort();
    // Leave the registry first, so `countSurfacesShowing` below no longer counts this surface. The answers
    // that follow do go out (`deps.respond` is not gated on `disposed`): a surface closing is not an answer,
    // and pi would stay parked behind a question nothing can show any more.
    this.unregisterSurface();
    // Answer any dialog still open in the (now gone) surface so pi doesn't hang — unless another surface
    // is still showing the same question, where the human can answer it.
    for (const id of this.forwardedUi) {
      if (countSurfacesShowing(id) > 0) continue;
      answerUiRequest(id, {
        type: 'extension_ui_response',
        id,
        cancelled: true,
      });
    }
    this.forwardedUi.clear();
    this.detach();
    this.runtime = null;
  }
}

function getMimeType(ext: string, isImage: boolean): string {
  if (isImage) {
    const map: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    };
    return map[ext] ?? 'application/octet-stream';
  }
  const textMap: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    css: 'text/css',
    scss: 'text/x-scss',
    html: 'text/html',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    csv: 'text/csv',
  };
  return textMap[ext] ?? 'text/plain';
}

/** Whitespace-insensitive comparison key for a session entry's text. */
function normalizeEntryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One durable edit as the webview renders it. The two extra kinds of {@link ContextEditView.kind} —
 * `applying` and `failed` — are the state of an operation this host just ran, and are merged over
 * these by the caller that ran it: the file only ever knows what pi has already written.
 */
function contextEditViewOf(record: ContextEditRecord): ContextEditView {
  return {
    entryId: record.targetId,
    kind: record.kind,
    toolCallId: record.originalToolCallId,
    replacementText: record.replacementText,
    originalText: record.originalText,
    preCompaction: record.preCompaction || undefined,
  };
}
