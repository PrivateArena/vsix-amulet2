import { resolve as resolvePath } from 'node:path';
import { RpcClient } from '../rpc/rpc-client';
import { parseCommandInvocation } from '../../shared/command-invocation';
import {
  buildSpawnEnv,
  buildStartupArgs,
  getAgentVersion,
  resolveBinaryPath,
} from './bootstrap';
import { bridgeSpawnArgs } from './bridge-args';
import type { PiConfig } from '../config';
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ModelInfo,
  PromptDisposition,
  PromptStreamingBehavior,
  RpcEvent,
  RuntimeStatus,
  SessionState,
  ThinkingLevel,
} from '../../shared/protocol';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  show(): void;
}

type Listener<T> = (value: T) => void;

/**
 * How long {@link PiRuntime.landedOn} waits for a `get_state` after a `switch_session` that did not
 * answer. It only has to catch a switch that succeeded but whose response got lost — a pi old
 * enough to hang on the command will not answer `get_state` any faster, so a short budget keeps the
 * `--session` fallback as snappy as it was before.
 */
const STATE_PROBE_TIMEOUT_MS = 2_000;

function sameSessionFile(
  sessionFile: string | undefined,
  sessionPath: string,
): boolean {
  return !!sessionFile && resolvePath(sessionFile) === resolvePath(sessionPath);
}

/**
 * A single pi runtime bound to one working directory. Owns the RpcClient,
 * applies startup settings, tracks status, and provides basic crash recovery.
 */
export class PiRuntime {
  private client: RpcClient | null = null;
  private status: RuntimeStatus = { phase: 'stopped' };
  private readonly eventListeners = new Set<Listener<RpcEvent>>();
  private readonly uiListeners = new Set<Listener<ExtensionUiRequest>>();
  private readonly statusListeners = new Set<Listener<RuntimeStatus>>();
  private disposed = false;
  private starting: Promise<void> | null = null;
  private restartAttempts = 0;
  /**
   * Session file the loaded child reported (`get_state.sessionFile`), but only while it has
   * content. This is what {@link restart} and crash recovery resume, so an intentional stop — a
   * setting change, a pi update, a package reload — no longer drops the conversation the human is
   * reading and boots a brand-new session.
   */
  private loadedSessionPath: string | undefined;
  /**
   * Session file the next {@link doStart} must resume. Set when a resume is requested and cleared
   * once the child reports what it actually loaded, so it survives a crash inside the resume
   * window — including the `--session` fallback of {@link switchSession}.
   */
  private pendingSessionPath: string | undefined;
  /** Cached `pi --version`, re-resolved only when the resolved binary changes. */
  private agentVersion = '';
  private agentVersionFor = '';
  /**
   * Names of the extension commands this child process reported, refreshed by every
   * {@link getCommands}. They belong to the process, not to a surface, which is why the
   * runtime owns them: pi only runs `/name` text that matches one of these, and the host
   * must know that before it chooses between `prompt` and `steer`.
   */
  private extensionCommands = new Set<string>();

  constructor(
    readonly cwd: string,
    private readonly getConfig: () => PiConfig,
    private readonly log: Logger,
    /**
     * Installed extension directory, which is where the context-surgery bridge bundle lives. Empty in
     * a runtime built outside the extension host, and then the bridge is simply not loaded.
     */
    private readonly extensionDir = '',
  ) {}

  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Drop the cached `pi --version` so the next start() re-probes. Needed after an
   * in-place `pi update`, which changes the version behind an unchanged path.
   */
  invalidateAgentVersion(): void {
    this.agentVersionFor = '';
    this.agentVersion = '';
  }

  get isReady(): boolean {
    return this.status.phase === 'ready' && !!this.client?.running;
  }

  onEvent(listener: Listener<RpcEvent>): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onExtensionUiRequest(listener: Listener<ExtensionUiRequest>): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }
  onStatus(listener: Listener<RuntimeStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** The session file a respawn of this runtime should resume, if there is one worth resuming. */
  getSessionPath(): string | undefined {
    return this.resumeTarget();
  }

  /**
   * Bring the child up, resuming `sessionPath` when given.
   *
   * A request that arrives while a start is already in flight is folded into that start, then
   * routed through {@link switchSession} if it wanted a different session — otherwise the first
   * caller's argument would silently win, which used to mean "resume nothing".
   */
  async start(sessionPath?: string): Promise<void> {
    if (this.starting) {
      await this.starting;
      if (sessionPath && this.isReady && this.resumeTarget() !== sessionPath) {
        await this.switchSession(sessionPath);
      }
      return;
    }
    if (this.isReady && !sessionPath) return;
    this.starting = this.doStart(sessionPath);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * The `pi -e` fragment that loads Amulet's context-surgery bridge, or `[]`.
   *
   * Decided per spawn against the version this child reports: the flag is argv, so a `pi update` that
   * lands while the runtime is up cannot silently start loading an extension into an older process.
   */
  private bridgeArgs(config: PiConfig): string[] {
    return bridgeSpawnArgs({
      extensionDir: this.extensionDir,
      enabled: config.contextEditing,
      agentVersion: this.agentVersion,
      log: (message) => this.log.info(message),
    });
  }

  private async doStart(sessionPath?: string): Promise<void> {
    const config = this.getConfig();
    if (sessionPath) this.pendingSessionPath = sessionPath;
    const resolved = resolveBinaryPath(config.binaryPath);
    // Re-resolve the version only when the binary path actually changes, so a
    // restart with the same binary doesn't pay for another `pi --version` spawn.
    if (this.agentVersionFor !== resolved.command) {
      this.agentVersion = getAgentVersion(resolved.command);
      this.agentVersionFor = resolved.command;
    }
    this.setStatus({
      phase: 'starting',
      binaryPath: resolved.command,
      cwd: this.cwd,
    });
    this.log.info(
      `Starting pi runtime: ${resolved.command} (cwd: ${this.cwd})`,
    );
    // A new child process loads its own extensions; commands from the previous one
    // must not decide how text is routed to this one.
    this.extensionCommands.clear();
    if (!resolved.resolved) {
      this.log.warn(
        `Could not resolve "${config.binaryPath}" to an absolute path. Relying on PATH. ` +
          `Searched: ${resolved.searchedDirs.slice(0, 8).join(', ')}…`,
      );
    }

    const client = new RpcClient({
      binaryPath: resolved.command,
      cwd: this.cwd,
      args: buildStartupArgs(config, sessionPath, this.bridgeArgs(config)),
      env: buildSpawnEnv(config),
    });
    this.client = client;

    client.onEvent((event) => this.dispatchEvent(event));
    client.onExtensionUiRequest((req) => {
      for (const l of this.uiListeners) l(req);
    });
    // Identity guard: an intentional stop nulls `this.client` before killing the child, so the
    // exit of a superseded process must not re-enter crash recovery. It used to — `stop()` only
    // waits 1.5s and can resolve on the SIGKILL timeout, and a late exit landing while a new
    // child is already ready nulled the client and spawned a *second* live child for this cwd.
    client.onExit((code, signal) => {
      if (client !== this.client) return;
      this.handleExit(code, signal);
    });

    client.start();

    try {
      // Confirm the process is live and apply session settings.
      const state = await client.getState();
      this.rememberSession(state);
      await this.applySettings(client, config);
      this.restartAttempts = 0;
      // The loaded file is the resume target now; drop the request so a later crash-recovery
      // restart doesn't re-resume a session file this child has already moved past.
      this.pendingSessionPath = undefined;
      this.setStatus({
        phase: 'ready',
        binaryPath: resolved.command,
        cwd: this.cwd,
      });
      this.log.info(
        `pi runtime ready. Model: ${state.model?.name ?? '(none)'}. Session: ${
          this.loadedSessionPath ?? '(new)'
        }`,
      );
      // Prime the extension-command names this process registered: the host has to know them
      // before it routes text (`isExtensionCommand`), and a command is worthless if the
      // first one typed after startup is queued instead of run.
      void this.getCommands().catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to start pi runtime: ${message}`);
      await client.stop().catch(() => undefined);
      this.client = null;
      this.setStatus({
        phase: 'error',
        message: this.friendlyStartupError(config.binaryPath, message),
        binaryPath: resolved.command,
        cwd: this.cwd,
      });
      throw err;
    }
  }

  /**
   * Push the settings that are wire state rather than spawn arguments.
   *
   * `amulet.defaultModel` is deliberately absent: it is the model a *new* session starts on and is
   * applied as a spawn argument (see `buildStartupArgs`). A resumed session keeps the model its own
   * file records — re-pinning it here would change the model mid-conversation, which makes pi drop
   * the replayed thinking blocks and invalidate the provider prompt cache for the whole context.
   */
  private async applySettings(
    client: RpcClient,
    config: PiConfig,
  ): Promise<void> {
    try {
      // `disabled` deliberately sends nothing: the pi settings, the resumed session
      // and the model's own default then decide the thinking level.
      if (config.thinkingLevel !== 'disabled') {
        await client.setThinkingLevel(config.thinkingLevel);
      }
      await client.setAutoCompaction(config.autoCompact);
      await client.setAutoRetry(config.autoRetry);
    } catch (err) {
      this.log.warn(
        `Failed to apply some settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private friendlyStartupError(binaryPath: string, raw: string): string {
    if (/ENOENT|not running|spawn/i.test(raw)) {
      return `Could not launch "${binaryPath}". Make sure the pi runtime is installed and on your PATH, or set an absolute path in "amulet.binaryPath".`;
    }
    return raw;
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    const wasReady = this.status.phase === 'ready';
    this.client = null;
    this.log.warn(`pi runtime exited (code=${code}, signal=${signal}).`);
    this.setStatus({
      phase: 'error',
      message: `Runtime exited (code=${code}). Use "Restart Runtime" to reconnect.`,
    });

    // Auto-recover a previously-healthy runtime a couple of times.
    if (wasReady && this.restartAttempts < 2) {
      this.restartAttempts++;
      this.log.info(
        `Auto-restarting pi runtime (attempt ${this.restartAttempts})…`,
      );
      void this.start(this.resumeTarget()).catch(() => undefined);
    }
  }

  /**
   * Stop the child and bring it back on the *same* session.
   *
   * Every restart trigger in the extension is a settings or package change — none of them is a
   * request to forget the conversation. Before, `start()` ran with no resume path, so an edited
   * setting booted a fresh session while the webview kept painting the old history.
   */
  async restart(): Promise<void> {
    this.restartAttempts = 0;
    const resume = this.resumeTarget();
    await this.stopClient();
    await this.start(resume);
  }

  /**
   * Retire the current client. Nulling `this.client` *before* the kill is what makes the exit
   * handler's identity check recognise this as an intentional stop.
   */
  private async stopClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.stop().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopClient();
    this.eventListeners.clear();
    this.uiListeners.clear();
    this.statusListeners.clear();
    this.setStatus({ phase: 'stopped' });
  }

  // --- Operations (guarded) ------------------------------------------------

  private requireClient(): RpcClient {
    if (!this.client || !this.client.running) {
      throw new Error('pi runtime is not running');
    }
    return this.client;
  }

  /**
   * Send a prompt. `streamingBehavior` decides what pi does when a run is
   * already in flight (`queued` disposition) — it is ignored while idle.
   *
   * `longRunning` is for an extension command, whose response only lands when the handler
   * returns: a dialog it opened parks that reply for as long as the human takes to answer.
   */
  prompt(
    message: string,
    images?: unknown[],
    streamingBehavior?: PromptStreamingBehavior,
    options?: { longRunning?: boolean },
  ): Promise<PromptDisposition | undefined> {
    return this.requireClient().prompt(
      message,
      images,
      streamingBehavior,
      options,
    );
  }
  steer(message: string): Promise<unknown> {
    return this.requireClient().steer(message);
  }
  abort(): Promise<unknown> {
    return this.requireClient().abort();
  }
  getState(): Promise<SessionState> {
    return this.requireClient().getState();
  }
  getAvailableModels(): Promise<ModelInfo[]> {
    return this.requireClient().getAvailableModels();
  }
  setModel(provider: string, modelId: string): Promise<ModelInfo> {
    return this.requireClient().setModel(provider, modelId);
  }
  cycleModel(): Promise<ModelInfo | null> {
    return this.requireClient().cycleModel();
  }
  setThinkingLevel(level: ThinkingLevel): Promise<unknown> {
    return this.requireClient().setThinkingLevel(level);
  }
  setAutoCompaction(enabled: boolean): Promise<unknown> {
    return this.requireClient().setAutoCompaction(enabled);
  }
  cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
    return this.requireClient().cycleThinkingLevel();
  }
  /** Thinking levels the current model supports, as reported by the runtime. */
  getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    return this.requireClient().getAvailableThinkingLevels();
  }
  compact(customInstructions?: string): Promise<unknown> {
    return this.requireClient().compact(customInstructions);
  }
  async newSession(): Promise<void> {
    const client = this.requireClient();
    // A brand-new session replaces the file a respawn would resume, so both the request and the
    // remembered file have to go before the command runs.
    this.pendingSessionPath = undefined;
    this.loadedSessionPath = undefined;
    await client.newSession();
    await this.rememberCurrentSession(client);
  }
  setSessionName(name: string): Promise<unknown> {
    return this.requireClient().setSessionName(name);
  }
  getMessages(): Promise<unknown[]> {
    return this.requireClient().getMessages();
  }
  /**
   * Load another session file.
   *
   * pi >= 1.4 answers `switch_session` in-process — verified against 1.5.0, where it returns
   * `{cancelled:false}` immediately and the next `get_state` reports the new `sessionFile` from the
   * same child. That keeps the warm process: the HTTP connection pool, the resolved model, thinking
   * level and tool loadout that all sit at the front of the cached prompt prefix, and it stops
   * aborting a running turn just to change files. pi 0.80.x never answered the command at all, so
   * the old "kill the child, respawn with `--session`" route stays as the fallback.
   */
  async switchSession(sessionPath: string): Promise<{ cancelled?: boolean }> {
    const client = this.client;
    if (client?.running) {
      try {
        const result = await client.switchSession(sessionPath);
        if (!result.cancelled) await this.rememberCurrentSession(client);
        this.log.info(
          `Switched session in-process${result.cancelled ? ' (cancelled by an extension)' : ''}: ${sessionPath}`,
        );
        return result;
      } catch (err) {
        // A slow switch can still have landed; only respawn when it did not.
        if (await this.landedOn(client, sessionPath)) {
          await this.rememberCurrentSession(client);
          return { cancelled: false };
        }
        this.log.warn(
          `switch_session did not answer (${err instanceof Error ? err.message : String(err)}); ` +
            `respawning pi with --session instead.`,
        );
      }
    }
    // Stash the path so a crash during the respawn still lands on this session.
    this.pendingSessionPath = sessionPath;
    this.restartAttempts = 0;
    await this.stopClient();
    await this.start(sessionPath);
    return {};
  }

  /** Whether this child has already loaded `sessionPath`, bounded so a wedged child can't stall it. */
  private landedOn(client: RpcClient, sessionPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STATE_PROBE_TIMEOUT_MS);
      client.getState().then(
        (state) => {
          clearTimeout(timer);
          resolve(sameSessionFile(state.sessionFile, sessionPath));
        },
        () => {
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }
  fork(entryId: string): Promise<{ text?: string; cancelled?: boolean }> {
    return this.requireClient().fork(entryId);
  }
  getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.requireClient().getForkMessages();
  }
  getSessionStats(): Promise<unknown> {
    return this.requireClient().getSessionStats();
  }
  exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.requireClient().exportHtml(outputPath);
  }
  getCommands(): Promise<
    Array<{ name: string; description?: string; source: string }>
  > {
    return this.requireClient()
      .getCommands()
      .then((commands) => {
        this.extensionCommands = new Set(
          commands
            .filter((c) => c.source === 'extension')
            .map((c) => c.name)
            .filter((name) => !!name),
        );
        return commands;
      });
  }
  /**
   * Whether pi would run this text as a registered extension command instead of
   * sending it to the model. False whenever the list has never been fetched — then
   * the caller keeps whatever route it chose, which is the pre-existing behaviour.
   */
  isExtensionCommand(text: string): boolean {
    const invocation = parseCommandInvocation(text);
    return !!invocation && this.extensionCommands.has(invocation.name);
  }
  respondToExtensionUi(response: ExtensionUiResponse): void {
    this.client?.respondToExtensionUi(response);
  }

  // --- Internal ------------------------------------------------------------

  /** What a respawn should resume: the loaded file, or the one a resume is mid-flight for. */
  private resumeTarget(): string | undefined {
    return this.loadedSessionPath ?? this.pendingSessionPath;
  }

  /**
   * Record the session a respawn should resume. A session file with no messages is not worth
   * resuming — pi boots an empty context either way — so it is not remembered.
   */
  private rememberSession(state: SessionState): void {
    this.loadedSessionPath =
      state.sessionFile && state.messageCount > 0
        ? state.sessionFile
        : undefined;
  }

  private async rememberCurrentSession(client: RpcClient): Promise<void> {
    if (!client.running) return;
    try {
      this.rememberSession(await client.getState());
    } catch {
      // The child is going away; whatever it last reported stands.
    }
  }
  private dispatchEvent(event: RpcEvent): void {
    for (const l of this.eventListeners) l(event);
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = {
      ...status,
      agentVersion: status.agentVersion ?? this.agentVersion,
    };
    for (const l of this.statusListeners) l(this.status);
  }
}
