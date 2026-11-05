# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

**Amulet** (`amulet`) is a VS Code extension that embeds the [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) as a chat sidebar. The extension host spawns an external `pi --mode rpc` child process and speaks its JSON-lines RPC protocol; a React webview renders the streaming conversation, thinking, and tool calls.

The `pi` runtime is **not bundled** — it is an external CLI the user must install and authenticate separately. The extension resolves the binary from `amulet.binaryPath` (default `pi`).

## Architecture

```
┌──────────────── VS Code ────────────────┐        ┌── pi --mode rpc (child) ──┐
│ Webview (React)  ⇄  Extension Host (Node)│  stdio │ JSON-lines over           │
│ chat / streaming    spawns + bridges     │  ⇄     │ stdin / stdout            │
└──────────────────────────────────────────┘        └───────────────────────────┘
```

Two independently-bundled targets:

- **Extension host** — CommonJS / Node, entry [`src/extension.ts`](src/extension.ts) → `dist/extension.js`. `vscode` is external (provided by the runtime).
- **Webview** — browser IIFE / React, entry [`webview/src/main.tsx`](webview/src/main.tsx) → `dist/webview.js`. No Node built-ins.

The two communicate only via `postMessage`. Both share a single source of truth for message shapes: [`shared/protocol.ts`](shared/protocol.ts).

### Key files

| Concern                                         | Location                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared protocol types (RPC + Host↔Webview)      | [`shared/protocol.ts`](shared/protocol.ts)                                                                                                                                                                                                                                                                 |
| Extension entry / activation                    | [`src/extension.ts`](src/extension.ts)                                                                                                                                                                                                                                                                     |
| RPC framing + typed client                      | [`src/rpc/`](src/rpc/) (`jsonl.ts`, `rpc-client.ts`, `rpc-process.ts`)                                                                                                                                                                                                                                     |
| Runtime bootstrap (binary resolution, env/PATH) | [`src/runtime/bootstrap.ts`](src/runtime/bootstrap.ts)                                                                                                                                                                                                                                                     |
| Runtime lifecycle + crash recovery              | [`src/runtime/pi-runtime.ts`](src/runtime/pi-runtime.ts)                                                                                                                                                                                                                                                   |
| Session/runtime pool                            | [`src/session/session-manager.ts`](src/session/session-manager.ts)                                                                                                                                                                                                                                         |
| Sidebar webview provider                        | [`src/provider.ts`](src/provider.ts)                                                                                                                                                                                                                                                                       |
| Editor-tab chat panels                          | [`src/editor/panel-manager.ts`](src/editor/panel-manager.ts)                                                                                                                                                                                                                                               |
| Host↔webview bridge                             | [`src/webview/chat-bridge.ts`](src/webview/chat-bridge.ts)                                                                                                                                                                                                                                                 |
| Right-click menu on the chat body               | [`webview/src/components/entry-list/transcript-menu.tsx`](webview/src/components/entry-list/transcript-menu.tsx), sources in [`webview/src/utils/md-units.ts`](webview/src/utils/md-units.ts), DOM→text in [`webview/src/utils/dom-markdown.ts`](webview/src/utils/dom-markdown.ts)                        |
| pi extension dialogs (pi-gate approvals)        | [`src/webview/ui-request-routing.ts`](src/webview/ui-request-routing.ts) (one owner, ack watchdog, single answer), [`src/webview/ui-surfaces.ts`](src/webview/ui-surfaces.ts) (surface registry + fan-out), [`webview/src/components/ui/permission-prompt/`](webview/src/components/ui/permission-prompt/) |
| Image results of a tool call                    | [`src/webview/tool-image.ts`](src/webview/tool-image.ts), [`webview/src/components/exec-view/tool-images/`](webview/src/components/exec-view/tool-images/) — base64 is stripped off the wire in [`shared/blocks.ts`](shared/blocks.ts) and re-read from disk when a card opens                             |
| Commands / config                               | [`src/commands.ts`](src/commands.ts), [`src/config.ts`](src/config.ts)                                                                                                                                                                                                                                     |
| "Look at this" notifications (host-side)        | [`src/notify/`](src/notify/) — `run-report.ts` (which wire event is the final report), `approval-prompt.ts` (which dialog parks the run), `approval-ledger.ts` (which ones are still unanswered), `system-channel.ts` (OS notifier), `notify-service.ts` (VS Code toast + status bar)                      |
| pi package manager (installed list, enable/disable, install/remove) | [`src/packages/`](src/packages/) — `package-settings.ts` reads/edits the `packages` arrays of pi's `settings.json`, `package-catalog.ts` resolves a source to its on-disk package, `package-service.ts` runs the `pi install`/`pi remove` child; state in [`webview/src/stores/packages-store.ts`](webview/src/stores/packages-store.ts), UI in [`webview/src/components/ui/packages-dialog/`](webview/src/components/ui/packages-dialog/), shared source rules in [`shared/pi-packages.ts`](shared/pi-packages.ts) |
| React app root + state                          | [`webview/src/App.tsx`](webview/src/App.tsx), [`webview/src/store.ts`](webview/src/store.ts)                                                                                                                                                                                                               |
| React components                                | [`webview/src/components/`](webview/src/components/)                                                                                                                                                                                                                                                       |

## Build & dev commands

The package manager is **pnpm** (`pnpm-lock.yaml`, `pnpm-workspace.yaml`; VS Code tasks call `pnpm`).

```sh
pnpm install
pnpm run build        # bundle host + webview once (node esbuild.mjs)
pnpm run watch        # rebuild on change (background)
pnpm run typecheck    # tsc --noEmit  — the only type-check gate
pnpm run package      # scripts/build-vsix.sh: typecheck + tests + prod bundle + vsce package (.vsix)
pnpm run format       # prettier --write
```

`scripts/build-vsix.sh` is the one-shot VSIX builder and needs no pnpm on PATH (it uses
`node_modules/.bin` for `tsc`/`vitest` and falls back to `npx @vscode/vsce`). Run it directly with
`./scripts/build-vsix.sh --fast` to skip the gates, or `--install` to load the artifact into the
local VS Code. The artifact is written to `/tmp/amulet/<name>-<version>.vsix` by default; `--notmp`
writes it to `<repo>/vsix/` instead (both are git-ignored by the `*.vsix` rule).

- **Run/debug:** press **F5** ("Run Amulet Extension") to launch an Extension Development Host; the `pnpm: watch` task starts automatically. Open the **Amulet** view in the activity bar.
- **Bundling is esbuild only** ([`esbuild.mjs`](esbuild.mjs)). `tsc` is configured with `noEmit` and is used _purely_ for type-checking — do not expect it to produce output.
- `.scss` files are compiled by a custom sass plugin in `esbuild.mjs` and injected as CSS; load paths are rooted at `webview/src`.

### Verifying changes

There is a unit test suite (`pnpm run test`, vitest) for the pure logic in `shared/` and the webview
reducer. After any change, at minimum run `pnpm run typecheck`. For behavioral changes, launch the
Extension Development Host (F5) and exercise the affected flow — most logic spans the host↔webview
boundary and only surfaces at runtime.

### Debugging the pi wire protocol

Runtime-side bugs (streaming, tool state, history) can be reproduced **without VS Code**:
`node scripts/rpc-probe.mjs "<prompt>"` spawns `pi --mode rpc` the same way `RpcProcess` does and
appends every raw JSON-lines event to `tmp/rpc-events.jsonl` (plus a one-line summary per event to
stdout). `PROBE_COMMANDS='{"type":"get_messages"};...'` fires extra RPC commands after the prompt to
check command handlers. When a UI/renderer assumption is in doubt, replay the captured event
sequence into `reducer()` in a test — `webview/src/store.test.ts` has a `pi 1.4.0 wire shapes`
suite built from such a capture.

## Conventions

- **TypeScript strict mode**, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Keep code warning-clean.
- **Formatting (Prettier, [`.prettierrc`](.prettierrc)):** single quotes, semicolons, 2-space indent (`useTabs: false`), trailing commas everywhere, `bracketSameLine: true`. Run `pnpm run format` before finishing. (Some existing files are tab-indented — Prettier is the source of truth; don't hand-match stray tabs.)
- **Webview components** follow a per-folder pattern: `component-name/` containing `component-name.tsx`, `component-name.scss`, and `index.ts` (barrel export). File names are kebab-case; React component exports are PascalCase.
- **Webview state:** [`zustand`](webview/src/store.ts) (`store.ts`, plus focused stores under `webview/src/stores/`). Prefer the store over prop-drilling for cross-cutting chat state.
- **Never import `vscode` in webview code** — it is not available in the browser bundle. The webview talks to the host only through `postMessage` using the `WebviewMessage` / `HostMessage` unions in `shared/protocol.ts`.
- **Protocol changes are cross-cutting:** adding a message type or field means updating `shared/protocol.ts` first, then both the host handler ([`chat-bridge.ts`](src/webview/chat-bridge.ts)) and the webview consumer. RPC command/event names must mirror the pi runtime's rpc-mode contract.
- The RPC and streaming-event types are intentionally _loose/open_ (`{ type: string; [k: string]: unknown }`) — the runtime emits more than the UI renders, and unknown payloads are forwarded as-is. Don't tighten them into exhaustive unions.

## Configuration surface

Extension settings live under the `amulet.*` namespace (declared in [`package.json`](package.json) `contributes.configuration`): `binaryPath`, `agentDir`, `defaultModel`, `thinkingLevel`, `autoCompact`, `autoRetry`, `expandThinking`, `privacyMode`, `privacyRules`, `notifyOnTurnDone`, `notifyOnApproval`, `notifySystem`, `extraArgs`. A key the user has not set in `amulet.*` falls back to its pre-rebrand `pintra.*` twin (the extension shipped as Pintra until 1.0.14) — see `LEGACY_SECTION`/`isExplicitlySet` in [`src/config.ts`](src/config.ts); the legacy namespace is **read-only**. `affectsRestart` / `affectsSetting` watch both namespaces, so editing a `pintra.*` key still restarts the runtime and re-applies the thinking level. Changing a **restart-affecting** setting triggers a runtime restart via `affectsRestart` in [`src/config.ts`](src/config.ts) — keep that list in sync when adding settings that alter how the child process is spawned. `expandThinking` is webview-only: the host pushes it in the `config` `HostMessage` (see `webviewConfig()`), and the webview writes it back with the `setExpandThinking` `WebviewMessage` (into `amulet.*` only).

`privacyMode` + `privacyRules` are the other webview-only pair, and they follow the same route
(`setPrivacyMode` → `amulet.privacyMode` → `webviewConfig()` → `config`). Two rules they must keep:

- **Censoring is rendering, never data.** The rules run on the string a component is about to paint, so
  chat state, the session file, `export_html` and every string sent to pi stay untouched. Anything that
  goes *back* into the run — Branch from here, Quote, Reply, an image's real path, a fork's message text —
  must read the untouched source (`rawSourceOf` in [`webview/src/utils/md-units.ts`](webview/src/utils/md-units.ts)),
  never what was shown. Text with no registered source (a terminal `<pre>`) is only ever available censored.
- **New rules are settings, not code.** [`shared/privacy.ts`](shared/privacy.ts) owns the rule shape, the
  compile (an unparseable entry is reported, never silently dropped) and `redactWithRules`; a new text leaf
  only calls `useRedact()` / `redactText()` from
  [`webview/src/stores/privacy-store.ts`](webview/src/stores/privacy-store.ts). Censor **before** any
  tokenizer runs (highlight.js splits a path across spans, so a rule cannot match afterwards) — that is why
  `MdRender` and `CodeBlock` rewrite their source rather than their output.

`thinkingLevel` defaults to **`disabled`**, which means the host sends _nothing_ to the runtime — pi's own settings, the resumed session and the model default decide (`applySettings` in [`src/runtime/pi-runtime.ts`](src/runtime/pi-runtime.ts)). The chat-box picker never invents its menu: it renders the levels the runtime reports from `get_available_thinking_levels` (derived from the model's `thinkingLevelMap`), pushed as the `thinkingLevels` `HostMessage` and refreshed on model change and on open. `get_state.thinkingLevel` is optional — when the runtime has no level applied, the picker shows **Disabled**. See "Thinking level contract" in [`docs/pintra-fork.md`](docs/pintra-fork.md).

The three `notify*` keys are the only settings **not** part of `PiConfig`: they describe the UI, not the child
process, so `notifySettings()` in [`src/config.ts`](src/config.ts) reads them at delivery time and a change
takes effect on the next alert (never a restart, never a webview push). Two alerts exist, and both are
decided host-side because both moments are already handled there: a run finishing its report, and a pi dialog
parked on an answer. Rules worth keeping:

- **A clean report is announced on `agent_end`, a bad one on `agent_settled`.** `agent_settled` is the true
  end of a run, but it lands after retries and post-run compaction — minutes after the reply was readable,
  which is the delay the alert exists to avoid. So a `stopReason: 'stop'` reply pings from `agent_end`, while
  `'error'` and `'length'` are held: pi re-enters the loop after `agent_end` for auto-retry, truncation
  recovery and compaction, and a run that looks failed at `agent_end` is often still working. `agent_end`'s
  own `willRetry` cannot make that call (it is the auto-retry predicate only, and `_prepareRetry` can still
  decline), so a held failure is released — or dropped, if `agent_settled.aborted` says the human stopped it
  — when the run settles.
- **One alert per dialog, owned by the claim; retired by the answer.** `beginUiRequest` elects one
  orchestrating bridge and only that bridge alerts. Retirement is the `onSettled` hook of the single-answer
  slot, so it happens wherever the answer came from — this surface, another one, or the native fallback —
  and it runs in a `finally`, because a throwing alert hook must never make the router hand pi a second
  answer for one question. Non-modal methods never alert: `notify`/`setStatus`/`setWidget` are emitted in a
  tight loop, and every bridge handles those. Dialogs are classified by their `title` prefix (`pi-gate:`,
  `pi-subagent:`) but every modal method alerts, so an unseen extension is still covered.
- **The toast is the record, the OS notifier is the reach.** VS Code's notification is visible inside the
  workbench only, so the OS channel (`notify-send`, macOS `display notification`, Windows balloon tip) fires
  while the window is unfocused — always through `spawn(argv, { shell: false })`, never a shell string, with
  the text in argv or (on Windows) in the environment, so no report body is ever parsed. The freedesktop
  urgency vocabulary is `low | normal | critical` and nothing else — an unknown level exits 1, which reads as
  "no notifier here". An unanswered dialog is `critical` because that is the tier that survives
  Do-Not-Disturb, and since servers may clip a notification body, the _title_ carries the quoted command.
  Positional text is `--`-terminated: a report or folder name starting with `-` would otherwise be eaten by
  getopt, and a notifier that refuses three notifications in a row (too old for our options) is dropped
  rather than respawned for every alert. An unanswered dialog is tracked per runtime, because a restart of one workspace folder must not
  silence a question another folder is still parked on.
  No OS channel is fatal: the toast, the "approval waiting" status-bar entry, and the dialog itself remain.
  While one is unanswered the status bar counts them ([`approval-ledger.ts`](src/notify/approval-ledger.ts),
  which is why it is per-runtime: a restart of one workspace folder must not silence a question another is
  still parked on), because a notification expires and an unanswered dialog does not; a dialog whose extension times out on its own (pi-subagent's 5-minute ceiling) is dropped when it
  does. `Amulet: Test Notification` proves which channel the machine actually has.

## Gotchas

- Dialog routing must not depend on `WebviewView.visible`/`WebviewPanel.visible`: VS Code only pushes that
  flag on `onDidChangeVisibility` (it starts `false`), so it is wrong in both directions across versions. The
  host therefore shows a dialog on **every** live surface, the webview proves it painted one by measuring its
  own overlay (`extensionUiShown`), and if nothing proves it within the watchdog window the host answers with
  a native VS Code dialog. `extension_ui_response` goes out exactly once per request id. Every step logs as
  `[ui] …` in the Amulet output channel.
- The `pi` binary is external and may not be on VS Code's PATH. Bootstrap logic and version detection live in [`src/runtime/bootstrap.ts`](src/runtime/bootstrap.ts).
- Right-click inside the chat transcript is owned by the webview, not by VS Code. A block that renders a
  source string (`MdRender`, a thinking body) marks itself `data-copy-unit` and registers that string in a
  `WeakMap<Element, …>` — the menu must hand back the **raw markdown**, never the rendered DOM; only a partial
  selection (or a source-less `<pre>`) goes through `serializeDom`. Anything the menu declines (no unit under
  the cursor, no items) must leave the `contextmenu` event alone so the native menu still appears, and the
  selection is snapshotted at right-click time because clicking a menu item destroys it.
- The webview cannot access the microphone, filesystem, or Node APIs directly — everything goes through the host bridge.
- Compaction reports itself over **events**, not over the command that started it: pi answers `compact`
  only when the summarisation LLM call resolves (minutes on a large window), so the RPC client gives
  `compact`/`fork` a longer response budget (`LONG_RUNNING_COMMANDS`) and the UI drives progress and
  result off `compaction_start` / `compaction_end` / `summarization_retry_*`. The summary text never
  crosses the wire while it is being written, so a live compaction shows elapsed time and a cancel
  (`abort` cancels one), not a stream. A `compaction_end` always follows a `compaction_start` —
  failures arrive as `aborted: true` or `errorMessage`, never as a missing event — and
  `contextUsage.tokens` is `null` until the next assistant response, so the context meter falls back
  to the newest boundary's `estimatedTokensAfter`.
- Compaction boundaries never come back in the transcript. `get_messages` answers with the model-context
  **projection**, which hoists the newest boundary to the head of the list, zeroes every older one,
  and reports only `summary`/`tokensBefore`/`timestamp` — one card at the top of a reloaded session,
  which reads as a bug. So `postHistory` strips that role (`stripCompactionBoundaries`) and the
  boundaries live in the compact-history list instead: `requestCompactions` answers with rows read
  off the session file (`readBranchCompactions` in `src/session/session-store.ts`, branch-walked by
  `shared/session-entries.ts`), and `requestCompactionDetail` fetches one summary when its row is
  clicked. Both are on demand, so summaries never cross the wire unread. Not via `get_entries`
  either: it returns every persisted entry (multi-megabyte) to answer one list.
- An extension command is **prompt-only text and has no output channel**. There is no "run command"
  RPC: `/name args` executes because pi's `prompt` matches its first token against the registered
  extension commands, and `steer`/`follow_up` reject such text outright (pi 1.5.0: `Extension command
"/gatec" cannot be queued`). So every webview submission goes through `submitText` in
  [`src/webview/chat-bridge.ts`](src/webview/chat-bridge.ts), which sends a recognised command as a
  `prompt` even when the webview asked to queue it; the names come from `get_commands` cached on the
  runtime (`isExtensionCommand`) and matched by [`shared/command-invocation.ts`](shared/command-invocation.ts),
  which mirrors pi's rule exactly (offset 0, name up to the first literal space, case-sensitive). A
  recognised command answers `disposition: 'handled'`, writes nothing to the session and emits **no
  events**, so the extension's own `extension_ui_request`s are the only thing the user can see — which
  is why command output is a dialog concern, not a transcript one. `get_commands` ships
  `name`/`description`/`source`/`sourceInfo` only: argument hints (`getArgumentCompletions`,
  `argumentHint`) never cross the wire, so no client may build an argument menu — the launcher writes
  the invocation into the composer and the human finishes it. `ctx.ui.custom()` is a runtime-side no-op
  in RPC mode, so a TUI-only extension (`/system-prompt`) shows nothing in any client — not a bug
  Amulet can fix. Its `prompt` response only lands when the handler returns, so a dialog parks it:
  `submitText` sends it with `longRunning: true` (the 15-minute budget, not the 30s default). And
  when `handled` arrives with no dialog, toast or transcript event in sight (`visibleOutput`,
  `isUserVisibleUiMethod`), `reportSilentCommand` posts a `notice` HostMessage — one standalone
  `role: 'system'` row — rather than leaving the human with "nothing happened".
- **Packages are settings on disk, not wire state.** pi exposes no RPC command for `settings.json`, so
  the Packages dialog reads that file itself and edits one array element to enable or disable a
  declaration: `autoload: false` is pi's own disable flag (the same value its `pi config` TUI writes)
  and re-enabling collapses back to the plain string form unless resource filters remain in the entry.
  Only install and remove shell out, because those move npm/git checkouts — and both always pass an
  explicit trust flag (`-na` for user scope, `-l -a` for project scope), since without one `pi install`
  loads and runs the workspace's own extensions just to work out which scope it may write. Trust itself
  is decided the way pi decides it (`resolveProjectTrust`), not by reading `trust.json` alone: a folder
  with nothing trust-requiring is trusted without any stored decision, which is exactly the state a
  first `pi install -l` starts from. Nothing
  re-reads settings mid-run, so every change is pending until the runtimes restart: `reloadRequired` is
  a content fingerprint of the declarations against the value captured at `connect()` — never an mtime,
  because pi rewrites `settings.json` for unrelated reasons — and `reloadPackages` applies it. Broken
  declarations are still listed (unrecognised entry, missing checkout, unreadable file): a package pi
  skipped at startup is the main reason a human opens the dialog. pi dedupes declarations by package
  identity (npm name, git host/path, resolved local path) with project-before-user precedence, so rows
  carry `identity` and `shadowed`: a row pi will ignore is marked and its controls disabled.
- `dist/` is a build artifact (git-ignored) — never edit it by hand.
