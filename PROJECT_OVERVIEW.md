<!-- codegraph-file-count: 148, last-commit: 9906c564187081c7c29dc2c84afd21928a102193 -->

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

| Scope               | Files | Overview File                | One-line purpose                                      |
| ------------------- | ----- | ---------------------------- | ----------------------------------------------------- |
| `src/`+`shared/`+root | 32  | (this file)                  | Host: spawn/bridge pi, surfaces, settings, packaging  |
| `webview/`          | 116   | PROJECT_OVERVIEW.webview.md  | React chat bundle: reducer, streaming render, tool UI |

## File Tree

```
package.json              manifest: gunir.amulet, 13 amulet.* commands, onView:amulet.chatView
esbuild.mjs               2 bundles (cjs host / iife webview) + custom sass plugin
src/extension.ts          activate(): channel, SessionManager, surfaces, commands, config watcher
src/provider.ts           PiSidebarProvider — sidebar WebviewView surface
src/editor/panel-manager.ts  EditorChatManager — editor-tab chat surface
src/webview/              chat-bridge.ts (host<->webview), webview-surface.ts, ui-surfaces.ts,
                          ui-request-routing.ts, extension-ui.ts, html.ts
src/runtime/              bootstrap.ts (binary/env/args), pi-runtime.ts (lifecycle), pi-updater.ts
src/rpc/                  jsonl.ts, rpc-client.ts (request/response + events), rpc-process.ts (spawn/stdio)
src/session/              session-manager.ts (runtime pool), session-store.ts (session files on disk)
src/config.ts             PiConfig + amulet.*/pintra.* dual-namespace reads, restart keys
src/commands.ts           registerCommands(): palette entries -> surfaces/runtime ops
src/auth-store.ts         read/write pi auth.json (provider credentials)
shared/protocol.ts        RpcCommand / RpcEvent / WebviewMessage / HostMessage — single truth
shared/blocks.ts          normalizeContent + applyAssistantEvent (stream -> ContentBlock[])
scripts/                  build-vsix.sh (gates+package), rpc-probe.mjs (raw wire capture)
webview/                  -> PROJECT_OVERVIEW.webview.md
```

## Component Roles

| File / Module | Role | LOC | Key Exports (signatures) |
|---|---|---|---|
| src/extension.ts | Activation: output channel, pool, both surfaces, commands, config watcher | ~98 | `activate(context: vscode.ExtensionContext): void`, `createLogger(channel: vscode.LogOutputChannel): Logger` |
| src/provider.ts | Sidebar surface; owns one ChatBridge | ~113 | `class PiSidebarProvider implements vscode.WebviewViewProvider` — `resolveWebviewView(view): void`, `dispatch(message: WebviewMessage): Promise<void>`, `reconnect(): Promise<void>` |
| src/editor/panel-manager.ts | Editor-tab chat panel (same surface factory) | ~54 | `class EditorChatManager implements vscode.Disposable` — `open(): vscode.WebviewPanel` |
| src/webview/webview-surface.ts | Shared surface factory: HTML, bridge wiring, bundle watch | ~104 | `createWebviewSurface(webview, extensionUri, sessions, log, appVersion, options): WebviewSurface` |
| src/webview/chat-bridge.ts | **The bridge**: host<->webview messages, RPC fan-in, session/fork/auth/attachments | 1141 | `class ChatBridge` — `connect(): Promise<void>`, `handleMessage(m: WebviewMessage): Promise<void>`, `pushStats()`, `pushSnapshot()`, `onUiRequest(req: ExtensionUiRequest)` |
| src/webview/ui-request-routing.ts | Which surface answers a `pi` dialog | ~58 | `routeUiRequest(method: string, surfaces: UiSurfaceState): UiRoute`, `claimUiRequest(id: string, route: UiRoute): boolean` |
| src/webview/ui-surfaces.ts | Live visibility probes (VS Code flips `.visible` silently) | ~30 | `registerUiSurface(isVisible: () => boolean): () => void`, `hasVisibleUiSurface(): boolean` |
| src/webview/extension-ui.ts | Host-side handling of `extension_ui_request` (notify/status/widget vs dialogs) | ~97 | `handleExtensionUiRequest(...)` |
| src/webview/html.ts | CSP'd webview HTML + asset URIs | ~73 | `renderWebviewHtml(...)` |
| src/runtime/pi-runtime.ts | Per-cwd runtime: start/apply settings/crash status + guarded RPC facade | 336 | `class PiRuntime` — `start(sessionPath?: string): Promise<void>`, `restart()`, `onEvent(l: Listener<RpcEvent>): () => void`, `prompt(m: string, images?: unknown[])`, `switchSession(p: string): Promise<{cancelled?}>` |
| src/runtime/bootstrap.ts | Resolve `pi` binary, PATH/env, argv, version probe | ~130 | `resolveBinaryPath(binaryPath: string): ResolvedBinary`, `buildSpawnEnv(config: PiConfig)`, `buildStartupArgs(config, sessionPath?): string[]`, `getAgentVersion(binaryPath): string` |
| src/runtime/pi-updater.ts | Update the external `pi` CLI in place, then reload runtimes | ~130 | `updatePi(options: PiUpdateOptions): Promise<PiUpdateResult>` |
| src/rpc/rpc-client.ts | id-correlated request/response over stdio + event/UI dispatch | 299 | `class RpcClient` — `send(command: RpcCommand): Promise<RpcResponse>`, `call<T>(command): Promise<T>`, `respondToExtensionUi(r: ExtensionUiResponse): void` |
| src/rpc/rpc-process.ts | Spawn/kill child, stdout/stderr plumbing | ~158 | `class RpcProcess extends EventEmitter` — `start(): void`, `write(obj: unknown): void`, `stop(timeoutMs = 1500): Promise<void>` |
| src/rpc/jsonl.ts | Line framing (partial-chunk safe) | ~31 | `attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void` |
| src/session/session-manager.ts | Runtime pool per workspace folder + restart-all | ~60 | `getRuntime(cwd: string): PiRuntime`, `getActiveRuntime(): PiRuntime`, `restartAll(): Promise<void>` |
| src/session/session-store.ts | Read pi's on-disk session files (list/name metadata) | ~122 | `listSessions(agentDir, cwd, currentPath?): SessionInfo[]`, `buildSessionInfo(filePath): SessionInfo \| null` |
| src/config.ts | `amulet.*` reads with read-only `pintra.*` fallback; restart-key diff | ~104 | `readConfig(): PiConfig`, `webviewConfig(): WebviewConfig`, `affectsRestart(e): boolean`, `isExplicitlySet(cfg, key): boolean` |
| src/commands.ts | Palette commands -> runtime ops + surface reveals | ~119 | `registerCommands(context, sessions, provider, editorManager, log): void` |
| src/auth-store.ts | Provider credentials in `agentDir/auth.json` | ~61 | `readAuthStatus(agentDir): AuthStatus`, `writeAuthEntry(agentDir, providerId, entry): string` |
| shared/protocol.ts | All four message unions + wire payload shapes | 620 | `type RpcCommand`, `type RpcEvent`, `type WebviewMessage`, `type HostMessage`, `interface SessionStats`, `interface NestedToolCalls`, `interface ExtensionUiRequest` |
| shared/blocks.ts | Wire content -> typed blocks; folds streaming deltas | 214 | `normalizeContent(content: unknown): ContentBlock[]`, `applyAssistantEvent(blocks: ContentBlock[], event?: AssistantStreamEvent): ContentBlock[]` |
| scripts/rpc-probe.mjs | Reproduce runtime bugs outside VS Code; appends `tmp/rpc-events.jsonl` | ~67 | CLI: `node scripts/rpc-probe.mjs "<prompt>"` (`PROBE_COMMANDS` env for extra commands) |

## Cross-References

| File | Called by / calls | Why it's central |
|---|---|---|
| src/webview/chat-bridge.ts | `provider.ts` (`connect`/`dispatch`), `pi-runtime.ts`, `rpc-client.ts`, `config.ts`, `auth-store.ts`, `bootstrap.ts` | Every host↔webview behaviour (76 refs, largest file) |
| src/runtime/pi-runtime.ts | `session-manager.ts`, `chat-bridge.ts`; calls `rpc-client.ts`, `bootstrap.ts` | Sole gateway to the child process; owns restart/crash status |
| src/rpc/rpc-client.ts | `pi-runtime.doStart`, `chat-bridge`; calls `rpc-process.ts` | Request/response correlation + event fan-out point |
| src/provider.ts | `extension.activate`; calls `webview-surface.createWebviewSurface`, bridge | Sidebar entry point into the bridge |
| shared/blocks.ts | `webview/src/store.ts` (`applyRpcEvent`, `toUiMessage`, `seedToolsFromHistory`), `agent-timeline.tsx`, `session-store.ts` | Normalization that keeps the render layer alive |
| webview/src/store.ts | `contexts/chat-context.tsx`, all chat components | One reducer for the whole UI (see webview overview) |

## Data Flow

```
webview (React)              host (Node)                                pi --mode rpc (child)
  WebviewMessage  --->  ChatBridge.handleMessage  --->  PiRuntime op
                          (sendMessage|steer|abort|setModel|switchSession|providerLogin|pickFiles)
                                                     RpcClient.send -> stdin: {type,id,...}\n
                                                       prompt|steer|abort|get_state|get_messages|
                                                       get_available_models|set_thinking_level|
                                                       get_session_stats|switch_session|fork|compact|
                                                       get_commands|export_html|...
                                                     stdout: RpcResponse {id,...}   (correlated)
                             <--- onEvent: RpcEvent  {message_start|message_update|message_end|
                                                      tool_execution_start/update/end|turn_*|agent_*}
                             <--- extension_ui_request {id,method}  -> routeUiRequest/claim -> dialog
  HostMessage  <----  ChatBridge.post  (state|history|models|thinkingLevels|stats|sessions|commands|
                                        runtimeStatus|config|rpcEvent|extensionUiRequest|pickedFiles)
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
5. **Extension-UI closed loop** (pi-gate approvals): `routeUiRequest` → `claimUiRequest` → visible
   surface renders `pendingUi`; `cancelled`/no reply ⇒ pi resolves `undefined` ⇒ **deny**. Esc answers
   the dialog instead of aborting the run.
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

## Read Triggers

| If you need to... | Open these files |
|---|---|
| Change a wire/host/webview message or event shape | `shared/protocol.ts`, `src/webview/chat-bridge.ts`, `webview/src/store.ts`; capture real events with `scripts/rpc-probe.mjs` and replay in `webview/src/store.test.ts` |
| Fix streaming/thinking/tool rendering | `shared/blocks.ts`, `webview/src/store.ts`, `webview/src/components/entry-view/agent-timeline.tsx`, `exec-view/tool-call-view.tsx` |
| Change how/whether `pi` is spawned (binary, env, args, version) | `src/runtime/bootstrap.ts`, `src/config.ts`, `src/runtime/pi-runtime.ts` (`doStart`, `applySettings`, `handleExit`) |
| Add a chat-box action / toolbar button | `webview/src/apis/actions.ts`, `shared/protocol.ts` (`WebviewMessage`), `src/webview/chat-bridge.ts` (`handleMessage`) |
| Work on sessions (list, switch, rename, delete, fork, export) | `src/session/session-store.ts`, `src/webview/chat-bridge.ts` (session ops), `src/runtime/pi-runtime.ts` |
| Fix sidebar-vs-editor-tab layout/width bugs | `src/webview/webview-surface.ts`, `src/provider.ts`, `src/editor/panel-manager.ts`, `webview/src/assets/css/*.scss` |
| Touch approvals/dialogs from pi extensions | `src/webview/ui-request-routing.ts`, `src/webview/ui-surfaces.ts`, `src/webview/extension-ui.ts`, `webview/src/components/ui/permission-prompt/` |
| Change the context meter | `webview/src/components/input-bar/ctx-meter/context-usage.ts`, `src/webview/chat-bridge.ts` (`pushStats`) |
| Add/rename a setting | `package.json` (`contributes.configuration`), `src/config.ts` (`SECTION`, `affectsRestart`) |
| Verify anything end-to-end | `pnpm typecheck && pnpm test`, then F5 Extension Development Host — host↔webview bugs only appear at runtime |

## Dependencies

### Extension host (Node, `vscode` external)
| Package / Module | Role | Version |
|---|---|---|
| `vscode` API | Commands, webview views/panels, config, output channel | `@types/vscode` ^1.90 |
| `node:child_process`, `node:fs`, `node:os`, `node:readline` | Spawn `pi --mode rpc`, read session/auth files | runtime |

### Webview (browser IIFE)
| Package / Module | Role | Version |
|---|---|---|
| `react` / `react-dom` | UI | ^18.3.1 |
| `zustand` | Focused UI stores (composer, confirm, turn-nav, …) — not chat state | ^5.0.14 |
| `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` | Message rendering | ^9 / ^4 / ^7 / ^11 |
| `react-icons`, `@lobehub/icons-static-svg` | Icons + provider logos | ^5.7 / ^1.91 |

### Build & test
| Package / Module | Role | Version |
|---|---|---|
| `esbuild` | Two-target bundling (`esbuild.mjs`) | ^0.24 |
| `sass` | `.scss` → CSS via custom plugin | ^1.101 |
| `typescript` / `vitest` | `tsc --noEmit` is the only type gate; 12 test files, 138 tests | ^5.7 / ^4.1 |

## Build & Run

| Command | Purpose |
|---|---|
| `pnpm build` / `pnpm watch` | Bundle host + webview once / on change |
| `pnpm typecheck` | `tsc --noEmit` (never emits — bundling is esbuild only) |
| `pnpm test` | vitest (pure logic: `shared/`, reducer, routing) |
| `pnpm package` | `scripts/build-vsix.sh` → typecheck + tests + prod bundle + `.vsix` (`--fast`, `--install`, `--notmp`) |
| `node scripts/rpc-probe.mjs "<prompt>"` | Reproduce runtime bugs without VS Code (`tmp/rpc-events.jsonl`) |
