<!-- codegraph-file-count: 163, last-commit: 9906c564187081c7c29dc2c84afd21928a102193 -->

# Amulet v1.0.22 — TypeScript (Node host + React webview), VS Code extension

## Purpose

Amulet (`gunir.amulet`) embeds the external `pi` coding agent in VS Code: the extension host spawns
`pi --mode rpc` and bridges its JSON-lines stdio protocol into a React chat UI rendered in two
surfaces (sidebar view + editor tabs). Primary output: `amulet-<version>.vsix`, built by esbuild from
**two independent bundles** — CJS host (`src/`) and browser IIFE webview (`webview/`) — that share one
protocol source of truth (`shared/`). `pi` is never bundled; it is a user-installed CLI. Fork of
Pintra (`bilalbentoumi/pi-vsc` v1.0.5, MIT); wire-level findings and pi-1.4.0 captures live in
`.scratch/pintra-fork.md` (gitignored scratch — `docs/` is empty). React UI: see
**PROJECT_OVERVIEW.webview.md**.

## Architecture

```
extension.activate -> SessionManager (PiRuntime pool keyed by cwd) -> PiRuntime -> RpcClient -> RpcProcess
RpcProcess <-> stdio JSON-lines <-> `pi --mode rpc` (child process)
PiRuntime -> event listeners -> ChatBridge (one per webview surface) -> postMessage -> webview reducer
```

## Scope Map

| Scope                 | Files | Overview File               | One-line purpose                                          |
| --------------------- | ----- | --------------------------- | --------------------------------------------------------- |
| `src/`+`shared/`+root | 36    | (this file)                 | Host: spawn/bridge pi, surfaces, settings, packaging      |
| `pi-bridge/`          | 4     | (this file)                 | The pi extension Amulet ships: context surgery in-process |
| `webview/`            | 121   | PROJECT_OVERVIEW.webview.md | React chat bundle: reducer, streaming render, tool UI     |

## File Tree

```
package.json              manifest: gunir.amulet, 13 amulet.* commands, onView:amulet.chatView
esbuild.mjs               2 bundles (cjs host / iife webview) + custom sass plugin
src/extension.ts          activate(): channel, SessionManager, surfaces, commands, config watcher
src/provider.ts           PiSidebarProvider — sidebar WebviewView surface
src/editor/panel-manager.ts  EditorChatManager — editor-tab chat surface
src/webview/              chat-bridge.ts (host<->webview), webview-surface.ts, ui-surfaces.ts,
                          ui-request-routing.ts, extension-ui.ts, html.ts, tool-image.ts,
                          project-files.ts + project-paths.ts (`@`-mention file listing)
src/runtime/              bootstrap.ts (binary/env/args), pi-runtime.ts (lifecycle), pi-updater.ts
src/rpc/                  jsonl.ts, rpc-client.ts (request/response + events), rpc-process.ts (spawn/stdio)
src/session/              session-manager.ts (runtime pool), session-store.ts (session files on disk)
src/prompts/              prompt-resource.ts (read one prompt/skill file off disk, by pi's own reported path)
src/config.ts             PiConfig + amulet.*/pintra.* dual-namespace reads, restart keys
src/notify/               "look at this" alerts: run-report.ts (which event is the report),
                          approval-prompt.ts (which dialog parks the run), approval-ledger.ts (which ones are
                          still unanswered), system-channel.ts (OS notifier), attention.ts (payload+policy),
                          notify-service.ts (vscode glue, toast, status bar)
src/commands.ts           registerCommands(): palette entries -> surfaces/runtime ops
src/auth-store.ts         read/write pi auth.json (provider credentials)
shared/protocol.ts        RpcCommand / RpcEvent / WebviewMessage / HostMessage — single truth
shared/bridge-protocol.ts the `/amulet <json>` + `amulet:reply` contract between host and bridge
shared/session-entries.ts pi's persisted session entries → the compact-history list (branch walk, on demand)
shared/blocks.ts          normalizeContent + applyAssistantEvent (stream -> ContentBlock[])
pi-bridge/                amulet-bridge.ts (command + context/turn_end hooks), target-resolver.ts (handle -> entry ids),
                          pending-store.ts (override map + sidecar), pi-extension-api.ts (declared pi type mirror)
scripts/                  build-vsix.sh (gates+package), rpc-probe.mjs (raw wire capture), bridge-probe.mjs (real-child bridge ops)
webview/                  -> PROJECT_OVERVIEW.webview.md
```

## Component Roles

| File / Module                     | Role                                                                                                         | LOC  | Key Exports (signatures)                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/extension.ts                  | Activation: output channel, pool, both surfaces, commands, config watcher                                    | ~98  | `activate(context: vscode.ExtensionContext): void`, `createLogger(channel: vscode.LogOutputChannel): Logger`                                                                                                                                                     |
| src/provider.ts                   | Sidebar surface; owns one ChatBridge                                                                         | ~113 | `class PiSidebarProvider implements vscode.WebviewViewProvider` — `resolveWebviewView(view): void`, `dispatch(message: WebviewMessage): Promise<void>`, `reconnect(): Promise<void>`                                                                             |
| src/editor/panel-manager.ts       | Editor-tab chat panel (same surface factory)                                                                 | ~54  | `class EditorChatManager implements vscode.Disposable` — `open(): vscode.WebviewPanel`                                                                                                                                                                           |
| src/webview/webview-surface.ts    | Shared surface factory: HTML, bridge wiring, bundle watch                                                    | ~104 | `createWebviewSurface(webview, extensionUri, sessions, log, appVersion, options): WebviewSurface`                                                                                                                                                                |
| src/webview/chat-bridge.ts        | **The bridge**: host<->webview messages, RPC fan-in, session/fork/auth/attachments                           | 1141 | `class ChatBridge` — `connect(): Promise<void>`, `handleMessage(m: WebviewMessage): Promise<void>`, `pushStats()`, `pushSnapshot()`, `onUiRequest(req: ExtensionUiRequest)`                                                                                      |
| src/webview/ui-request-routing.ts | Lifecycle of one pi dialog: owner, paint ack, native fallback, one answer                                    | ~150 | `beginUiRequest(req, deps): boolean`, `armUiRequest(id, shown): void`, `ackUiRequest(id, visible): boolean`, `answerUiRequest(id, res): boolean`                                                                                                                 |
| src/webview/ui-surfaces.ts        | Live webview surfaces + dialog fan-out                                                                       | ~75  | `registerUiSurface(surface: UiSurface): () => void`, `showUiRequest(req, runtime): number`, `dismissUiRequest(id): void`, `countSurfacesShowing(id): number`                                                                                                     |
| src/webview/extension-ui.ts       | Host-side handling of `extension_ui_request` (notify/status/widget vs dialogs)                               | ~97  | `handleExtensionUiRequest(...)`                                                                                                                                                                                                                                  |
| src/webview/html.ts               | CSP'd webview HTML + asset URIs                                                                              | ~73  | `renderWebviewHtml(...)`                                                                                                                                                                                                                                         |
| src/webview/tool-image.ts         | Read one tool-result image off disk, typed by its file signature                                             | ~175 | `readToolImage(p, {cwd}): Promise<ToolImageResult>`, `resolveToolImagePath(p, cwd?): string \| null`, `isSupportedImage(filePath): Promise<boolean>`                                                                                                             |
| src/webview/project-files.ts      | Listing behind `@`-mentions: VS Code file search inside the open workspace, cached per directory             | ~190 | `listProjectFiles(cwd: string, force?: boolean): Promise<{paths: string[]; truncated: boolean}>`                                                                                                                                                                 |
| src/runtime/pi-runtime.ts         | Per-cwd runtime: start/resume, apply settings, crash recovery + guarded RPC facade                           | 542  | `class PiRuntime` — `start(sessionPath?: string): Promise<void>`, `restart()`, `getSessionPath(): string \| undefined`, `onEvent(l: Listener<RpcEvent>): () => void`, `prompt(m: string, images?: unknown[])`, `switchSession(p: string): Promise<{cancelled?}>` |
| src/runtime/bootstrap.ts          | Resolve `pi` binary, PATH/env, argv, version probe                                                           | ~145 | `resolveBinaryPath(binaryPath: string): ResolvedBinary`, `buildSpawnEnv(config: PiConfig)`, `buildStartupArgs(config, sessionPath?, bridgeArgs?): string[]`, `getAgentVersion(binaryPath): string`                                                               |
| src/runtime/bridge-args.ts        | Decides whether the child is started with the context-surgery bridge                                         | ~85  | `bridgeSpawnArgs({extensionDir, enabled, agentVersion, log}): string[]`, `supportsBridge(agentVersion): boolean`, `bridgeExtensionPath(extensionDir): string`, `BRIDGE_BUNDLE_REL_PATH`                                                                          |
| pi-bridge/amulet-bridge.ts        | The pi extension Amulet loads: `/amulet` ops, the `context` override, `turn_end` drafts                      | ~290 | `export default function amuletBridge(pi: ExtensionAPI): void`, `class BridgeSessions` — speaks `shared/bridge-protocol.ts`, drafts only, never writes the session file                                                                                          |
| pi-bridge/pending-store.ts        | Not-yet-durable edits: applied to every request, persisted in the session's sidecar                          | ~370 | `class PendingStore` — `set/get/list/drafts/prune/applyTo/load/restore/file`, `matcherOf(entry)`, `sidecarPath(sessionFile)`                                                                                                                                     |
| src/webview/bridge-client.ts      | One surface's view of the bridge: reqId map, ack watchdog, capability probe                                  | ~190 | `class BridgeClient` — `isAvailable()`, `call(op, init): Promise<BridgeReply>`, `handleNotify(text): boolean`, `refreshCapabilities()`                                                                                                                           |
| src/runtime/pi-updater.ts         | Update the external `pi` CLI in place, then reload runtimes                                                  | ~130 | `updatePi(options: PiUpdateOptions): Promise<PiUpdateResult>`                                                                                                                                                                                                    |
| src/rpc/rpc-client.ts             | id-correlated request/response over stdio + event/UI dispatch                                                | 299  | `class RpcClient` — `send(command: RpcCommand): Promise<RpcResponse>`, `call<T>(command): Promise<T>`, `respondToExtensionUi(r: ExtensionUiResponse): void`                                                                                                      |
| src/rpc/rpc-process.ts            | Spawn/kill child, stdout/stderr plumbing                                                                     | ~158 | `class RpcProcess extends EventEmitter` — `start(): void`, `write(obj: unknown): void`, `stop(timeoutMs = 1500): Promise<void>`                                                                                                                                  |
| src/rpc/jsonl.ts                  | Line framing (partial-chunk safe)                                                                            | ~31  | `attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void`                                                                                                                                                                            |
| src/session/session-manager.ts    | Runtime pool per workspace folder + restart-all                                                              | ~60  | `getRuntime(cwd: string): PiRuntime`, `getActiveRuntime(): PiRuntime`, `restartAll(): Promise<void>`                                                                                                                                                             |
| src/session/session-store.ts      | Read pi's on-disk session files (list/name metadata, persisted compaction boundaries, durable context edits) | ~270 | `listSessions(agentDir, cwd, currentPath?): SessionInfo[]`, `readBranchCompactions(filePath): CompactionEntry[]`, `readBranchContextEdits(filePath): Promise<ContextEditRecord[]>`, `buildSessionInfo(filePath): SessionInfo \| null`                            |
| src/config.ts                     | `amulet.*` reads with read-only `pintra.*` fallback; restart-key diff                                        | ~104 | `readConfig(): PiConfig`, `webviewConfig(): WebviewConfig`, `affectsRestart(e): boolean`, `isExplicitlySet(cfg, key): boolean`                                                                                                                                   |
| src/notify/approval-ledger.ts     | Which dialogs are still unanswered, per runtime, with their expiry timers                                    | ~90  | `class ApprovalLedger` — `track(id, cwd, timeoutMs?)`, `settle(id)`, `clearRuntime(cwd)`, `has(id)`, `dispose()`                                                                                                                                                 |
| src/notify/notify-service.ts      | Only `vscode`-touching half of the alert feature: toast + OS channel + status bar                            | ~270 | `initNotifications(log): Disposable`, `watchRuntime(r): void`, `approvalRequested(req, cwd): void`, `approvalSettled(id): void`, `sendTestNotification(): Promise<void>`                                                                                         |
| src/commands.ts                   | Palette commands -> runtime ops + surface reveals                                                            | ~119 | `registerCommands(context, sessions, provider, editorManager, log): void`                                                                                                                                                                                        |
| src/auth-store.ts                 | Provider credentials in `agentDir/auth.json`                                                                 | ~61  | `readAuthStatus(agentDir): AuthStatus`, `writeAuthEntry(agentDir, providerId, entry): string`                                                                                                                                                                    |
| shared/protocol.ts                | All four message unions + wire payload shapes                                                                | 620  | `type RpcCommand`, `type RpcEvent`, `type WebviewMessage`, `type HostMessage`, `interface SessionStats`, `interface NestedToolCalls`, `interface ExtensionUiRequest`                                                                                             |
| shared/prompt-template.ts         | pi's template/skill expansion, mirrored — the parity contract for client-side insert                         | ~200 | `substitutePromptArgs(content, args)`, `analysePromptTemplate(content): TemplateArgumentShape`, `parseCommandArgs(s)`, `parsePromptInvocation(text)`, `formatSkillBlock(skill)`, `stripTemplateFrontmatter(content)`                                             |
| src/prompts/prompt-resource.ts    | Read the prompt/skill file pi reported, refusing anything outside its folders                                | ~140 | `readPromptResource(command, {agentDir, cwd}): { resource } \| { error }`, `MAX_PROMPT_RESOURCE_BYTES`                                                                                                                                                           |
| shared/blocks.ts                  | Wire content -> typed blocks; folds streaming deltas                                                         | 214  | `normalizeContent(content: unknown): ContentBlock[]`, `applyAssistantEvent(blocks: ContentBlock[], event?: AssistantStreamEvent): ContentBlock[]`                                                                                                                |
| scripts/rpc-probe.mjs             | Reproduce runtime bugs outside VS Code; appends `tmp/rpc-events.jsonl`                                       | ~70  | CLI: `node scripts/rpc-probe.mjs "<prompt>"` (`PROBE_COMMANDS` env for extra commands, `PROBE_ARGS_JSON` for extra argv)                                                                                                                                         |
| scripts/bridge-probe.mjs          | Drive a real `pi -e <bridge>` child through bridge ops, no VS Code, no API key needed                        | ~150 | CLI: `node scripts/bridge-probe.mjs [--session <file>] '<bridge op json>' [--messages]`                                                                                                                                                                          |

## Cross-References

| File                       | Called by / calls                                                                                                         | Why it's central                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| src/webview/chat-bridge.ts | `provider.ts` (`connect`/`dispatch`), `pi-runtime.ts`, `rpc-client.ts`, `config.ts`, `auth-store.ts`, `bootstrap.ts`      | Every host↔webview behaviour (76 refs, largest file)         |
| src/runtime/pi-runtime.ts  | `session-manager.ts`, `chat-bridge.ts`; calls `rpc-client.ts`, `bootstrap.ts`                                             | Sole gateway to the child process; owns restart/crash status |
| src/rpc/rpc-client.ts      | `pi-runtime.doStart`, `chat-bridge`; calls `rpc-process.ts`                                                               | Request/response correlation + event fan-out point           |
| src/provider.ts            | `extension.activate`; calls `webview-surface.createWebviewSurface`, bridge                                                | Sidebar entry point into the bridge                          |
| shared/blocks.ts           | `webview/src/store.ts` (`applyRpcEvent`, `toUiMessage`, `seedToolsFromHistory`), `agent-timeline.tsx`, `session-store.ts` | Normalization that keeps the render layer alive              |
| webview/src/store.ts       | `contexts/chat-context.tsx`, all chat components                                                                          | One reducer for the whole UI (see webview overview)          |

## Data Flow

```
webview (React)              host (Node)                                pi --mode rpc (child)
  WebviewMessage  --->  ChatBridge.handleMessage  --->  PiRuntime op
                          (sendMessage|steer|abort|setModel|switchSession|providerLogin|pickFiles|
                           loadToolImage|openToolImage|requestProjectFiles)
                                                     RpcClient.send -> stdin: {type,id,...}\n
                                                       prompt|steer|abort|get_state|get_messages|
                                                       get_available_models|set_thinking_level|
                                                       get_session_stats|switch_session|fork|compact|
                                                       get_commands|export_html|...
                                                     stdout: RpcResponse {id,...}   (correlated)
                             <--- onEvent: RpcEvent  {message_start|message_update|message_end|
                                                      tool_execution_start/update/end|turn_*|agent_*}
                             <--- extension_ui_request {id,method}  -> broadcast + ack watchdog -> dialog
  HostMessage  <----  ChatBridge.post  (state|history|models|thinkingLevels|stats|sessions|commands|
                                        runtimeStatus|config|rpcEvent|extensionUiRequest|extensionUiDismiss|
                                        pickedFiles|toolImage|projectFiles)
  reducer(state, {type:'host',message}) -> React
```

## Key Architectural Patterns

1. **Two bundles, one protocol file.** Adding a message means `shared/protocol.ts` first, then
   `chat-bridge.handleMessage` (webview→host) and `ChatBridge.post`/reducer (host→webview). RPC names
   must mirror pi's rpc-mode contract; both unions stay intentionally loose
   (`{ type: string; [k: string]: unknown }`) so unknown runtime events are forwarded, not fatal.
2. **Pool + fan-out:** one `PiRuntime` per cwd, N `ChatBridge` instances (sidebar + each editor tab)
   subscribing to the same runtime. Per-surface vs global state is not cleanly separated — audit
   before moving state into a bridge.
3. **Normalization at the wire boundary** (`normalizeContent`, `applyAssistantEvent`): pi 1.4.0 sends
   `role:"system"` with a **string** `content`, and `message_update` carries per-`contentIndex` deltas
   (`text_*`, `thinking_*`, `toolcall_*`) instead of a cumulative snapshot; `message_end` is the
   authoritative payload. Never render raw `content` — always go through `shared/blocks.ts`.
4. **Nested tool calls** (subagent/codemode): child calls arrive as ordinary tool events with
   `parentToolCallId` and id `<parent>/<n>`; the webview keeps them as `ToolExec.childIds`, never as
   message blocks. `message.nestedCalls` in history is pi's bounded record that drops successful
   outputs — reloaded cards cannot expand results.
5. **Extension-UI closed loop** (pi-gate approvals): every live surface shows the dialog
   (`showUiRequest`), one bridge orchestrates (`beginUiRequest`/`armUiRequest`), and a surface proves it
   painted it (`extensionUiShown`/`ackUiRequest`) because `WebviewView.visible` is a pushed flag that lies in
   both directions. Nobody proves it within `UI_DIALOG_ACK_TIMEOUT_MS` ⇒ VS Code's own dialog takes over.
   `answerUiRequest` is the only route to `extension_ui_response` and fires once per id; the other copies get
   `extensionUiDismiss`. No reply ⇒ pi resolves `undefined` ⇒ **deny**. Esc answers the dialog instead of
   aborting the run.
6. **Stats ownership split:** host `pushStats` (on connect, `newChat`, `compact`, `turn_end`,
   `agent_end`, `compaction_end` — never per delta) vs webview `contextUsageOf`, which re-derives
   tokens from the streaming `message_end`/late `usage` deltas to fill the intra-turn gap.
7. **Thinking levels are harness-owned:** list comes from `get_available_thinking_levels` (model's
   `thinkingLevelMap`), `get_state.thinkingLevel` is optional (unset ⇒ UI shows "Disabled"),
   `set_thinking_level` clamps server-side, and pi emits **no** model-changed event — so capabilities
   re-push on every host-initiated model change.
8. **Config & lineage:** unknown `amulet.<key>` silently falls back to the read-only `pintra.<key>`
   twin (`inspect()`-based, so declared defaults don't shadow); restart-affecting keys live in
   `affectsRestart`. Requires **pnpm 10** (`allowBuilds`). Lineage: `../vsix-amulet/extension/` is
   EULA'd — study only, never copy; Pintra is MIT.
9. **Image payloads stop at the host.** A tool result's base64 (`read` on an image) is redacted
   before it reaches the webview — `stripEventImages` on every forwarded event (including the
   `turn_end`/`agent_end` recaps) and `stripHistoryImagePayloads` on every history push — and the
   webview keeps only a `ToolImageRef`. Pixels cross on request (`loadToolImage`), from disk,
   typed by the file's **signature** rather than by its name or by what the runtime reported.
   A card asks only while it is expanded, and the reducer retires the oldest delivered pixels
   past a retention budget.
10. **Compaction is event-owned, never command-owned.** pi answers `{"type":"compact"}` only after
    its summarisation call resolves (minutes), so `RpcClient` lifts the response budget for
    `compact`/`fork` (`LONG_RUNNING_COMMANDS`); the 30s default is what used to surface as
    _"Timeout waiting for response to \"compact\""_ on a compaction that then succeeded. The
    transcript card comes off `compaction_start`/`compaction_end` (`webview/src/store.ts` →
    `compaction` run + a `role: 'compaction'` message rendered by `entry-list/compaction-card/`),
    which is also the only signal for the runtime's own threshold/overflow compaction. A **reload**
    puts none of them in the transcript: `get_messages` answers with the model-context projection,
    which hoists the **newest** boundary to the head of the list, zeroes every older one and reports
    only `summary`/`tokensBefore`/`timestamp` — one card, out of place, that reads as a bug. So
    `postHistory` strips that role, and the compact-history button beside the context meter answers
    instead: `requestCompactions` reads the branch's boundaries off the session file
    (`readBranchCompactions` + `shared/session-entries.ts`) when the button is hovered, and
    `requestCompactionDetail` fetches one summary when its row is clicked, so a summary never crosses
    the wire unread. The summary text itself **cannot**
    stream: `completeSummarization` awaits a detached provider call
    whose deltas never reach an rpc client — the live card therefore shows elapsed time,
    `summarization_retry_*` and a cancel (`abort` cancels a compaction), not a token count.
    The meter has the same gap: `contextUsage.tokens` is null right after a compaction, so
    `contextUsageOf` falls back to the newest boundary's `estimatedTokensAfter`.
11. **An extension command is a prompt, never queued input, and it has no output.** pi has
    no "run command" RPC: `/name args` executes because the `prompt` path matches its first
    token against the registered commands, and `steer`/`follow_up` **reject** such text
    (verified against pi 1.5.0: `Extension command "/gatec" cannot be queued`). So
    `submitText` in `chat-bridge.ts` is the only route to the runtime and it re-routes a
    recognised command to `prompt` even when the webview asked to queue it — the names come
    from `get_commands`, cached per process on `PiRuntime`, warmed up at start, and matched
    by `shared/command-invocation.ts`, which mirrors pi's matcher (offset 0, name up to the
    first literal space, case-sensitive). A recognised command answers `disposition:`
    `"handled"`, writes nothing to the session and emits no events at all; its only visible
    product is the `extension_ui_request`s its handler chose, so command output can _only_
    reach the UI through the dialog path. `get_commands` carries `name`/`description`/
    `source`/`sourceInfo` and nothing else — argument hints never cross the wire, which is
    why the launcher writes the invocation into the composer instead of building an
    argument menu. And `ctx.ui.custom()` is a runtime-side no-op in RPC mode, so a TUI-only
    extension (`/system-prompt`) shows nothing in any client — not a bug Amulet can fix (Pendant
    renders it because it embeds the SDK and pipes real pi-tui frames into xterm.js; it is not an
    RPC client). Two consequences of `handled`, both owned by `submitText`:
    - the response only lands when the handler **returns**, so a dialog it opened parks the
      `prompt` reply for as long as the human takes — hence the `longRunning` budget in
      `rpc-client.ts`, since the 30s default would fail a command that worked;
    - nothing is guaranteed to be visible, so `reportSilentCommand` compares the bridge's
      `visibleOutput` counter (dialogs, toasts, transcript events — `isUserVisibleUiMethod` plus
      `VISIBLE_EVENT_TYPES`) across the call and, when it did not move, posts a `notice`
      HostMessage: one standalone `role: 'system'` transcript row. Re-checked after a grace
      period, because a handler may `notify` without awaiting it.
12. **Prompt templates and skills are expanded by the client, from pi's own file.** A
    `source: 'prompt'` / `'skill'` row of `get_commands` is a markdown file, and
    `sourceInfo.path` says which one — the only route to a template's argument shape, since
    `argumentHint` is computed inside pi's TUI and never crosses the wire. So the composer
    opens a form instead of sending `/name args`: `shared/prompt-template.ts` mirrors pi's
    `substituteArgs`/`parseCommandArgs`/skill envelope byte for byte (verified against the real
    installed runtime), `src/prompts/prompt-resource.ts` reads the reported file and refuses
    anything outside pi's own folders, and **Insert** puts the expanded text in the draft. The
    reason is one anchor: `expandPromptTemplate` matches `^`, so a message carrying two
    `/prompts` hands the second one to the first as arguments and silently loses it — expanded
    prose cannot be swallowed, which is what makes several prompts in one message possible.
    Rules that follow: a draft whose leading command is a template or skill is **never** sent as
    a command (`leadingPromptCommand` intercepts it, mirroring pi's precedence — an extension
    command of the same name wins, and a skill only counts with the literal `skill:` namespace);
    the text that lands in the composer must be what pi would have sent, so parity is the test;
    and the dialog paints the censored preview while inserting the untouched body, like every
    other Privacy-mode text leaf. Nothing is submitted here — the submit button still is the
    only thing that runs a turn.

## Read Triggers

| If you need to...                                                  | Open these files                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change a wire/host/webview message or event shape                  | `shared/protocol.ts`, `src/webview/chat-bridge.ts`, `webview/src/store.ts`; capture real events with `scripts/rpc-probe.mjs` and replay in `webview/src/store.test.ts`                                                                                                                                                            |
| Fix streaming/thinking/tool rendering                              | `shared/blocks.ts`, `webview/src/store.ts`, `webview/src/components/entry-view/agent-timeline.tsx`, `exec-view/tool-call-view.tsx`                                                                                                                                                                                                |
| Change how/whether `pi` is spawned (binary, env, args, version)    | `src/runtime/bootstrap.ts`, `src/config.ts`, `src/runtime/pi-runtime.ts` (`doStart`, `applySettings`, `handleExit`)                                                                                                                                                                                                               |
| Add a chat-box action / toolbar button                             | `webview/src/apis/actions.ts`, `shared/protocol.ts` (`WebviewMessage`), `src/webview/chat-bridge.ts` (`handleMessage`)                                                                                                                                                                                                            |
| Work on sessions (list, switch, rename, delete, fork, export)      | `src/session/session-store.ts`, `src/webview/chat-bridge.ts` (session ops), `src/runtime/pi-runtime.ts`                                                                                                                                                                                                                           |
| Fix sidebar-vs-editor-tab layout/width bugs                        | `src/webview/webview-surface.ts`, `src/provider.ts`, `src/editor/panel-manager.ts`, `webview/src/assets/css/*.scss`                                                                                                                                                                                                               |
| Touch approvals/dialogs from pi extensions                         | `src/webview/ui-request-routing.ts`, `src/webview/ui-surfaces.ts`, `src/webview/extension-ui.ts`, `webview/src/components/ui/permission-prompt/`; the Amulet output channel logs every routing decision as `[ui] …`                                                                                                               |
| Change the context meter                                           | `webview/src/components/input-bar/ctx-meter/context-usage.ts`, `src/webview/chat-bridge.ts` (`pushStats`)                                                                                                                                                                                                                         |
| Change compaction (progress, card, timeout, cancel)                | `src/rpc/rpc-client.ts` (`LONG_RUNNING_COMMANDS`), `src/webview/chat-bridge.ts` (`runCompact`), `shared/session-entries.ts`, `src/session/session-store.ts`, `webview/src/store.ts`, `entry-list/compaction-card/`                                                                                                                |
| Change the compact-history list / boundary dialog                  | `shared/session-entries.ts`, `src/session/session-store.ts` (`readBranchCompactions`), `src/webview/chat-bridge.ts` (`pushCompactions`/`pushCompactionDetail`), `webview/src/stores/compaction-history-store.ts`, `components/input-bar/compaction-history/`, `components/ui/compaction-dialog/`                                  |
| Run or route a pi extension command (`/gatec`, `/subagentc`)       | `shared/command-invocation.ts`, `src/runtime/pi-runtime.ts` (`isExtensionCommand`, command cache warm-up in `doStart`), `src/webview/chat-bridge.ts` (`submitText`), `webview/src/components/input-bar/extension-commands/`                                                                                                       |
| Change prompt-template / skill insert (arguments, preview, dialog) | `shared/prompt-template.ts` (pi parity first), `src/prompts/prompt-resource.ts`, `src/webview/chat-bridge.ts` (`pushPromptResource`), `webview/src/utils/prompt-insert.ts`, `webview/src/stores/prompt-dialog-store.ts`, `webview/src/components/ui/prompt-dialog/`, `.../input-bar/composer.tsx` (`submit`, `applySlashCommand`) |
| Show or change what an image tool result does to the wire          | `shared/blocks.ts` (`stripEventImages`/`stripHistoryImagePayloads`), `src/webview/tool-image.ts`, `src/webview/chat-bridge.ts` (`loadToolImage`)                                                                                                                                                                                  |
| Add/rename a setting                                               | `package.json` (`contributes.configuration`), `src/config.ts` (`SECTION`, `affectsRestart`)                                                                                                                                                                                                                                       |
| Change Omit / Edit context content / Revert (host or bridge)       | `shared/bridge-protocol.ts` (contract first), `pi-bridge/`, `src/webview/bridge-client.ts`, `src/webview/chat-bridge.ts` (`runContextOp`/`runRevert`), `AGENTS.md` “Context surgery”; verify against a real child with `node scripts/bridge-probe.mjs`                                                                            |
| Change what the transcript shows for an edited result              | `src/webview/history-repair.ts`, `src/session/session-store.ts` (`readBranchContextEdits`), `webview/src/store.ts` (`applyContextEdits`, `ToolExec.ctxEdit`), `webview/src/components/exec-view/`                                                                                                                                 |
| Change when Amulet interrupts the user                             | `src/notify/` (`run-report.ts` for the report event, `approval-prompt.ts` for the dialog kinds, `system-channel.ts` for the OS notifier)                                                                                                                                                                                          |
| Verify anything end-to-end                                         | `pnpm typecheck && pnpm test`, then F5 Extension Development Host — host↔webview bugs only appear at runtime                                                                                                                                                                                                                      |

## Dependencies

### Extension host (Node, `vscode` external)

| Package / Module                                            | Role                                                   | Version               |
| ----------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
| `vscode` API                                                | Commands, webview views/panels, config, output channel | `@types/vscode` ^1.90 |
| `node:child_process`, `node:fs`, `node:os`, `node:readline` | Spawn `pi --mode rpc`, read session/auth files         | runtime               |

### Webview (browser IIFE)

| Package / Module                                                      | Role                                                                | Version            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------ |
| `react` / `react-dom`                                                 | UI                                                                  | ^18.3.1            |
| `zustand`                                                             | Focused UI stores (composer, confirm, turn-nav, …) — not chat state | ^5.0.14            |
| `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` | Message rendering                                                   | ^9 / ^4 / ^7 / ^11 |
| `react-icons`, `@lobehub/icons-static-svg`                            | Icons + provider logos                                              | ^5.7 / ^1.91       |

### Build & test

| Package / Module        | Role                                                           | Version     |
| ----------------------- | -------------------------------------------------------------- | ----------- |
| `esbuild`               | Two-target bundling (`esbuild.mjs`)                            | ^0.24       |
| `sass`                  | `.scss` → CSS via custom plugin                                | ^1.101      |
| `typescript` / `vitest` | `tsc --noEmit` is the only type gate; 12 test files, 138 tests | ^5.7 / ^4.1 |

## Build & Run

| Command                                     | Purpose                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm build` / `pnpm watch`                 | Bundle host + webview once / on change                                                                 |
| `pnpm typecheck`                            | `tsc --noEmit` (never emits — bundling is esbuild only)                                                |
| `pnpm test`                                 | vitest (pure logic: `shared/`, reducer, routing)                                                       |
| `pnpm package`                              | `scripts/build-vsix.sh` → typecheck + tests + prod bundle + `.vsix` (`--fast`, `--install`, `--notmp`) |
| `node scripts/rpc-probe.mjs "<prompt>"`     | Reproduce runtime bugs without VS Code (`tmp/rpc-events.jsonl`)                                        |
| `node scripts/bridge-probe.mjs '<op json>'` | Exercise the pi bridge against a real child (optional `--session`, `--messages`)                       |
