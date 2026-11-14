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

| Concern                                                                                  | Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared protocol types (RPC + Host↔Webview)                                               | [`shared/protocol.ts`](shared/protocol.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Extension entry / activation                                                             | [`src/extension.ts`](src/extension.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| RPC framing + typed client                                                               | [`src/rpc/`](src/rpc/) (`jsonl.ts`, `rpc-client.ts`, `rpc-process.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime bootstrap (binary resolution, env/PATH)                                          | [`src/runtime/bootstrap.ts`](src/runtime/bootstrap.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime lifecycle + crash recovery                                                       | [`src/runtime/pi-runtime.ts`](src/runtime/pi-runtime.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Session/runtime pool                                                                     | [`src/session/session-manager.ts`](src/session/session-manager.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sidebar webview provider                                                                 | [`src/provider.ts`](src/provider.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Editor-tab chat panels                                                                   | [`src/editor/panel-manager.ts`](src/editor/panel-manager.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Host↔webview bridge                                                                      | [`src/webview/chat-bridge.ts`](src/webview/chat-bridge.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Right-click menu on the chat body                                                        | [`webview/src/components/entry-list/transcript-menu.tsx`](webview/src/components/entry-list/transcript-menu.tsx), sources in [`webview/src/utils/md-units.ts`](webview/src/utils/md-units.ts), DOM→text in [`webview/src/utils/dom-markdown.ts`](webview/src/utils/dom-markdown.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| pi extension dialogs (pi-gate approvals)                                                 | [`src/webview/ui-request-routing.ts`](src/webview/ui-request-routing.ts) (one owner, ack watchdog, single answer), [`src/webview/ui-surfaces.ts`](src/webview/ui-surfaces.ts) (surface registry + fan-out), [`webview/src/components/ui/permission-prompt/`](webview/src/components/ui/permission-prompt/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Image results of a tool call                                                             | [`src/webview/tool-image.ts`](src/webview/tool-image.ts), [`webview/src/components/exec-view/tool-images/`](webview/src/components/exec-view/tool-images/) — base64 is stripped off the wire in [`shared/blocks.ts`](shared/blocks.ts) and re-read from disk when a card opens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Commands / config                                                                        | [`src/commands.ts`](src/commands.ts), [`src/config.ts`](src/config.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Prompt-template & skill insert (the arguments dialog)                                    | parity rules [`shared/prompt-template.ts`](shared/prompt-template.ts) · host reader [`src/prompts/prompt-resource.ts`](src/prompts/prompt-resource.ts) (name → pi's reported path, never a webview path) · routing `pushPromptResource` in [`src/webview/chat-bridge.ts`](src/webview/chat-bridge.ts) · webview [`webview/src/utils/prompt-insert.ts`](webview/src/utils/prompt-insert.ts), [`webview/src/stores/prompt-dialog-store.ts`](webview/src/stores/prompt-dialog-store.ts), [`webview/src/components/ui/prompt-dialog/`](webview/src/components/ui/prompt-dialog/)                                                                                                                                                                                                                                                                   |
| "Look at this" notifications (host-side)                                                 | [`src/notify/`](src/notify/) — `run-report.ts` (which wire event is the final report), `approval-prompt.ts` (which dialog parks the run), `approval-ledger.ts` (which ones are still unanswered), `system-channel.ts` (OS notifier), `notify-service.ts` (VS Code toast + status bar)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| pi package manager (installed list, enable/disable, install/remove)                      | [`src/packages/`](src/packages/) — `package-settings.ts` reads/edits the `packages` arrays of pi's `settings.json`, `package-catalog.ts` resolves a source to its on-disk package, `package-service.ts` runs the `pi install`/`pi remove` child; state in [`webview/src/stores/packages-store.ts`](webview/src/stores/packages-store.ts), UI in [`webview/src/components/ui/packages-dialog/`](webview/src/components/ui/packages-dialog/), shared source rules in [`shared/pi-packages.ts`](shared/pi-packages.ts)                                                                                                                                                                                                                                                                                                                            |
| Context surgery (Omit from context / Edit context content / Revert to this message)      | contract [`shared/bridge-protocol.ts`](shared/bridge-protocol.ts) · the pi extension Amulet ships: [`pi-bridge/`](pi-bridge/) (`amulet-bridge.ts` command + hooks, `target-resolver.ts` handle→entry ids, `pending-store.ts` override map + sidecar) · loaded by [`src/runtime/bridge-args.ts`](src/runtime/bridge-args.ts) (`pi -e`) · host client [`src/webview/bridge-client.ts`](src/webview/bridge-client.ts) (reqId↔ack, 15 s watchdog) · durable state reader [`src/session/session-store.ts`](src/session/session-store.ts) (`readBranchContextEdits`) · transcript repair [`src/webview/history-repair.ts`](src/webview/history-repair.ts) · badges `ToolExec.ctxEdit` in [`webview/src/store.ts`](webview/src/store.ts), menu rules [`webview/src/components/exec-view/card-menu.ts`](webview/src/components/exec-view/card-menu.ts) |
| Stop one command (Stop / Stop with reason, on a card **and** on a subagent's nested row) | same bridge, new op: [`pi-bridge/tool-stop.ts`](pi-bridge/tool-stop.ts) (live-call board, the aim, the note) + [`pi-bridge/process-tree.ts`](pi-bridge/process-tree.ts) (process table, group kill) · vocabulary + shell tool list [`shared/stop-command.ts`](shared/stop-command.ts) · `op: 'stop'` in [`shared/bridge-protocol.ts`](shared/bridge-protocol.ts) · host `runStopCommand` in [`src/webview/chat-bridge.ts`](src/webview/chat-bridge.ts) · buttons [`webview/src/components/exec-view/stop-actions/`](webview/src/components/exec-view/stop-actions/) + [`webview/src/components/ui/reason-dialog/`](webview/src/components/ui/reason-dialog/) · rules in [`webview/src/components/exec-view/card-menu.ts`](webview/src/components/exec-view/card-menu.ts) · runtime proof [`scripts/stop-probe.mjs`](scripts/stop-probe.mjs)    |
| React app root + state                                                                   | [`webview/src/App.tsx`](webview/src/App.tsx), [`webview/src/store.ts`](webview/src/store.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| React components                                                                         | [`webview/src/components/`](webview/src/components/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

Two more harnesses drive the bridge, which is the half of Amulet that only exists inside the child process:
`node scripts/bridge-probe.mjs '{"op":"omit",...}'` sends one bridge op (or a `hello` capability probe) and prints
the ack, and `node scripts/stop-probe.mjs "note"` runs the whole stop-a-hung-command chain against a live model turn
(`NESTED=1` stops a command a _subagent_ made instead). Both need `node esbuild.mjs` to have produced the bundle.

## Conventions

- **TypeScript strict mode**, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`. Keep code warning-clean.
- **Formatting (Prettier, [`.prettierrc`](.prettierrc)):** single quotes, semicolons, 2-space indent (`useTabs: false`), trailing commas everywhere, `bracketSameLine: true`. Run `pnpm run format` before finishing. (Some existing files are tab-indented — Prettier is the source of truth; don't hand-match stray tabs.)
- **Webview components** follow a per-folder pattern: `component-name/` containing `component-name.tsx`, `component-name.scss`, and `index.ts` (barrel export). File names are kebab-case; React component exports are PascalCase.
- **Webview state:** [`zustand`](webview/src/store.ts) (`store.ts`, plus focused stores under `webview/src/stores/`). Prefer the store over prop-drilling for cross-cutting chat state.
- **Never import `vscode` in webview code** — it is not available in the browser bundle. The webview talks to the host only through `postMessage` using the `WebviewMessage` / `HostMessage` unions in `shared/protocol.ts`.
- **Protocol changes are cross-cutting:** adding a message type or field means updating `shared/protocol.ts` first, then both the host handler ([`chat-bridge.ts`](src/webview/chat-bridge.ts)) and the webview consumer. RPC command/event names must mirror the pi runtime's rpc-mode contract.
- The RPC and streaming-event types are intentionally _loose/open_ (`{ type: string; [k: string]: unknown }`) — the runtime emits more than the UI renders, and unknown payloads are forwarded as-is. Don't tighten them into exhaustive unions.

## Configuration surface

Extension settings live under the `amulet.*` namespace (declared in [`package.json`](package.json) `contributes.configuration`): `binaryPath`, `agentDir`, `defaultModel`, `thinkingLevel`, `autoCompact`, `autoRetry`, `expandThinking`, `preserveLineBreaks`, `privacyMode`, `privacyRules`, `notifyOnTurnDone`, `notifyOnApproval`, `notifySystem`, `notifySticky`, `contextEditing`, `extraArgs`. A key the user has not set in `amulet.*` falls back to its pre-rebrand `pintra.*` twin (the extension shipped as Pintra until 1.0.14) — see `LEGACY_SECTION`/`isExplicitlySet` in [`src/config.ts`](src/config.ts); the legacy namespace is **read-only**. `affectsRestart` / `affectsSetting` watch both namespaces, so editing a `pintra.*` key still restarts the runtime and re-applies the thinking level. Changing a **restart-affecting** setting triggers a runtime restart via `affectsRestart` in [`src/config.ts`](src/config.ts) — keep that list in sync when adding settings that alter how the child process is spawned. `contextEditing` (default **on**) is one of them: it decides whether the child is started with the bridge that carries context surgery _and_ the per-command Stop, it is `machine`-scoped for the same reason as `extraArgs`, it has no `pintra.*` twin, and it is **not** part of `webviewConfig()` — whether the bridge is actually live is capability state about a running child, so it travels on the `bridgeStatus` HostMessage instead of a settings echo. `expandThinking` is webview-only: the host pushes it in the `config` `HostMessage` (see `webviewConfig()`), and the webview writes it back with the `setExpandThinking` `WebviewMessage` (into `amulet.*` only).

`privacyMode` + `privacyRules` are the other webview-only pair, and they follow the same route
(`setPrivacyMode` → `amulet.privacyMode` → `webviewConfig()` → `config`). Two rules they must keep:

- **Censoring is rendering, never data.** The rules run on the string a component is about to paint, so
  chat state, the session file, `export_html` and every string sent to pi stay untouched. Anything that
  goes _back_ into the run — Branch from here, Quote, Reply, an image's real path, a fork's message text —
  must read the untouched source (`rawSourceOf` in [`webview/src/utils/md-units.ts`](webview/src/utils/md-units.ts)),
  never what was shown. Text with no registered source (a terminal `<pre>`) is only ever available censored.
- **New rules are settings, not code.** [`shared/privacy.ts`](shared/privacy.ts) owns the rule shape, the
  compile (an unparseable entry is reported, never silently dropped) and `redactWithRules`; a new text leaf
  only calls `useRedact()` / `redactText()` from
  [`webview/src/stores/privacy-store.ts`](webview/src/stores/privacy-store.ts). Censor **before** any
  tokenizer runs (highlight.js splits a path across spans, so a rule cannot match afterwards) — that is why
  `MdRender` and `CodeBlock` rewrite their source rather than their output.

`preserveLineBreaks` (default **on**) is the third webview-only switch on that same route
(`setPreserveLineBreaks` → `amulet.preserveLineBreaks` → `webviewConfig()` → `config`), held in
[`webview/src/stores/line-breaks-store.ts`](webview/src/stores/line-breaks-store.ts) beside the privacy
store. It decides whether a message's soft newline paints as a line break, so it is rendering only: the
session file, the prompt and every copy path keep the author's own bytes either way. `useLineBreaks()`
subscribes and then reads the store live for the same reason `useRedact()` does — under
`useSyncExternalStore` a _server_ render answers with the initial state, so a selected value would freeze
the shipped default in a test render.

`thinkingLevel` defaults to **`disabled`**, which means the host sends _nothing_ to the runtime — pi's own settings, the resumed session and the model default decide (`applySettings` in [`src/runtime/pi-runtime.ts`](src/runtime/pi-runtime.ts)). The chat-box picker never invents its menu: it renders the levels the runtime reports from `get_available_thinking_levels` (derived from the model's `thinkingLevelMap`), pushed as the `thinkingLevels` `HostMessage` and refreshed on model change and on open. `get_state.thinkingLevel` is optional — when the runtime has no level applied, the picker shows **Disabled**. See "Thinking level contract" in [`docs/pintra-fork.md`](docs/pintra-fork.md).

The four `notify*` keys are the only settings **not** part of `PiConfig`: they describe the UI, not the child
process, so `notifySettings()` in [`src/config.ts`](src/config.ts) reads them at delivery time and a change
takes effect on the next alert (never a restart). `notifySticky` is the one of them the webview **does** see:
the menu has to show the switch, so `webviewConfig()` mirrors it (from `notifySettings()`, not from
`readConfig()` — it stays out of `PiConfig` for the same reason as its three siblings) and the menu writes it
back with the `setNotifySticky` `WebviewMessage`. Two alerts exist, and both are
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
  "no notifier here". **`critical` and "expires" cannot be asked for at once:** the convention every real
  server follows (verified against xfce4-notifyd, which honours a client timeout to the second for `low` and
  `normal` and ignores it entirely for `critical`) is that a critical banner survives Do-Not-Disturb _and_
  stays until a human clicks it away — which is exactly what a notification that never goes away looks like
  to a user. So `amulet.notifySticky` (menu: **Sticky approval alerts**, default **off**) picks between the
  two: off sends an unanswered dialog as `normal` with `--expire-time`, on sends it as `critical` and asks for
  no timeout at all. A finished run is never critical either way. Only the freedesktop channel has the choice
  — macOS `display notification` has no tiers and a Windows balloon tip always expires. Since servers may clip
  a notification body, the _title_ carries the quoted command.
  Positional text is `--`-terminated: a report or folder name starting with `-` would otherwise be eaten by
  getopt, and a notifier that refuses three notifications in a row (too old for our options) is dropped
  rather than respawned for every alert. An unanswered dialog is tracked per runtime, because a restart of one workspace folder must not
  silence a question another folder is still parked on.
  No OS channel is fatal: the toast, the "approval waiting" status-bar entry, and the dialog itself remain.
  While one is unanswered the status bar counts them ([`approval-ledger.ts`](src/notify/approval-ledger.ts),
  which is why it is per-runtime: a restart of one workspace folder must not silence a question another is
  still parked on), because a notification expires and an unanswered dialog does not; a dialog whose extension times out on its own (pi-subagent's 5-minute ceiling) is dropped when it
  does. `Amulet: Test Notification` proves which channel the machine actually has, and now names which tier
  the current settings ask for — "expires on the server clock" or "kept until dismissed".

## Context surgery: Amulet ships and owns a pi extension

**Omit from context**, **Edit context content** and **Revert to this message** are not RPC features (neither is stopping one
command — see the next section, which shares this bridge, its command transport and its idle-gate exception): `pi --mode rpc`
exposes a closed set of commands and not one of them mutates an existing session entry. They are reachable only
from inside the child process, so Amulet ships a pi extension — `pi-bridge/`, bundled by esbuild, loaded with
`pi -e <bundle>` at spawn (see `bridgeSpawnArgs` in `src/runtime/bridge-args.ts`, gated on `amulet.contextEditing`
and on `pi >= 1.4`). Read this before changing any of it:

- **The bridge is the only writer; Amulet is the only reader of intent.** Never append to pi's session file from
  the host (or from the bridge): a concurrent append branches off a stale leaf and silently loses the edit. The
  bridge only _proposes_ `context_edit` drafts at `turn_end`; pi writes them.
- **`context` for now, `turn_end` for later.** A durable edit cannot exist before the next turn boundary, but the
  first provider request of the next run happens _before_ any of its boundaries — so the immediate effect comes
  from `PendingStore.applyTo` in the `context` hook and the persistence from `PendingStore.drafts`. Dropping the
  hook would make an idle omission apply to the very request the user was protecting.
- **Transport is `prompt "/amulet <json>"` + a `notify` ack**, because an extension command's response carries only
  `{disposition}`. `BridgeClient` correlates by `reqId` (per bridge — N surfaces, one runtime, no double-apply) and
  `handleExtensionUiRequest` swallows the text before it can become a toast, on every surface, owned or not.
- **An omitted result is a placeholder, not a deletion.** A `toolCall` may not be left without its result, so hiding one
  output writes a replacement reading `CONTEXT_OMIT_PLACEHOLDER` and keeps the reply, its thinking and the sibling results
  in context — and in the transcript after a reload. `expandOmitGroup` therefore returns one entry for a tool result, and
  the whole turn only when the target _is_ the assistant reply (mirroring pi's own `_omitRecoveryAttempt`). The host turns
  that exact placeholder text back into an `omitted` badge and paints the original output again, so nothing a user only
  hid from the model ever disappears from their screen.
- **A pending edit must never outlive its branch.** `PendingStore.prune` forgets an edit whose target is no longer on the
  branch, as well as one the file already records: `appendContextEdit` **throws** for an off-branch target, and pi discards
  the whole boundary proposal when any draft fails — which would silently void every later turn's drafts, Amulet's and
  other extensions', for the life of the child.
- **Idle-only.** `navigateTree` throws during a run and a `context_edit` has no boundary to land in, so both the
  host gate (`bridgeGate`, the menu's `streaming` rule) and the bridge (`not-idle`) refuse mid-run.
- **Revert is `navigateTree(entryId, { summarize: false })`** — same session file, unlike `fork` (which is what
  "Branch from here" means). `summarize: true` would append content and cost an LLM call, which is exactly the
  cache argument below.
- **Cache rule (this one is load-bearing):** the bridge registers _no_ tool, prompt section or system-prompt edit,
  so its presence costs one prefix that never changes. A **context edit** is a cache _event_: it changes bytes
  behind the head, so the provider re-prefills everything after the edited entry — say so in any dialog that makes
  one. A **revert** re-prefills strictly less, because what it retains is a shorter prefix of what was already
  sent, and the abandoned tail is never re-sent.
- **The transcript shows the truth.** `get_messages` answers with the model-context projection, in which an omitted
  tool result carries the placeholder and a replaced one is indistinguishable from the real output — so
  `restoreOmittedToolResults` substitutes or re-inserts the original text from the session file
  (`readBranchContextEdits`) and the badge comes from the `contextEdits` push. Anything sent _back_ into the run
  (Quote, Reply, an edit's initial text) reads the untouched value in reducer state, never the badge.
- **A provisional badge belongs to a session file, not to a surface** (`src/webview/context-edit-views.ts`): N surfaces
  share one runtime and only the requester sees the ack, so the pending list is shared and retires itself when the durable
  record arrives. A refusal is posted **once** — a transient `not-idle` painted permanently onto a card is its own wrong.

## Stopping one command is not aborting the turn

A `bash` call that will not return is the one thing Amulet's Stop button could not do anything about: pi 1.5.0 has **no per-tool
cancellation**. `abort` (RPC), `AgentSession.abort()`, `Agent.abort()` and `ctx.abort()` are all the same run-level control — the
per-turn `AbortController` at `pi-agent-core/agent.js:814` — and its signal is what every executing tool holds, so pulling it ends the
turn, the tool, and a subagent's whole run with it. `abort_bash` is not a per-tool command either: it aborts the `_bashAbortControllers`
set that only `executeBash()` (the `!` shell) ever fills. What a hung command _does_ have is a process: pi's shell tools
`spawn(shell, [...args, command], { detached: true })`, so the command leads its own process group, and signalling that group is a stop that
touches nothing else. Read this before changing any of it:

- **The transport works _because_ it is an extension command.** `AgentSession.prompt()` says "Handle extension commands first (execute
  immediately, even during streaming)" — which is what makes `/amulet {"op":"stop",…}` reachable while the run is parked on the hang. A
  `steer` would not do: a steer waits for a turn boundary, and the hang is exactly what prevents one. `stop` is therefore the one op in
  `shared/bridge-protocol.ts` that must **not** be behind the bridge's `!ctx.isIdle()` gate (contrast the surgery ops).
- **The bridge is the only side that can name the target, so it is the only side that names it.** The webview sends a `toolCallId` and a
  note; the command text — which is what the process is matched on — comes from the bridge's own `tool_call` hook. Never let the host or a
  surface restate it: the aim of a `SIGKILL` must not be client input (the rule `prompt-resource.ts` applies to paths, applied harder).
- **Match on the command text, never on the program name.** bash replaces itself for a single simple command, so a hung `make world` is a
  process called `make` with nothing named bash left in it — a "find the shell" filter fails on precisely the commands this feature exists
  for. The set is restricted by _parent_ instead: only a direct child of the bridge's own pid can be a tool call's process. Age narrows the
  set only when the table has an epoch base (`ProcessTable.timeBase`; Windows CIM has none), and an empty age pool is a **refusal**, not a
  guess.
- **The fallback aim needs an only child _and_ an only call.** When the command text matches nothing (another extension rewrote
  `input.command` after the hook ran), the bridge may take the one process it can blame — but only while `StopBoard` holds **one** live
  call, because pi runs a batch's calls concurrently and two live calls means two plausible owners of that shell. `planStop` takes the count
  for exactly this reason, and `candidates`/`liveCalls` travel on the ack (`ToolStopEvidence`) so a stop that looked wrong is auditable after
  the fact. `matched: 'single-shell'` is what an honest guess is allowed to say about itself.
- **A group kill requires a group leader.** `process.kill(-pid)` is right only when `pgid === pid`; pi spawns its shells detached precisely so
  that is true. Without that check, a misread table would signal _pi's own_ process group and kill the runtime along with the command.
  `signalProcess` re-checks the parentage rather than trusting `planStop`, and the escalation to SIGKILL is decided against a **fresh** table
  (pids are recycled inside the 1.5 s grace) and only when some member of the target's group is still alive — a leader that obeyed SIGTERM
  can leave a worker behind, which is the hung build with its own toolchain this feature exists for. Windows has no such politeness:
  `process.kill` there is `TerminateProcess`, so it sends one SIGKILL and reports one, rather than claiming a TERM that never happened.
- **Reading the process table is one `ps`, not a `/proc` walk.** This runs synchronously inside the process that is streaming the model's
  response and servicing the RPC pipe, and walking `/proc` from JavaScript is two file reads per process on the machine. `/proc` survives as
  the fallback where `ps` is missing (and is the more accurate of the two where it runs).
- **The note is promised before the signal leaves.** A command that dies instantly would otherwise have its result pass the `tool_result`
  hook unannotated, and the model would read a bare exit code — which reads as a crash and invites the same 50-minute command again. That
  annotation is the _only_ channel that reaches the current turn: a run not aborted by the signal is indistinguishable from a command that
  simply failed. `shared/stop-command.ts` owns the sentence, in pi-gate's vocabulary (`Stopped by user with note:` beside its
  `Allowed/Blocked by user with note:`), because both extensions annotate the same result and the reason dialog previews the real text.
- **Nested calls work, which is the point.** A subagent's child session runs with **zero extensions**; its shim forwards every call back
  through `ctx.executeTool`, so the parent's `tool_call`/`tool_result` hooks see it as `<subagentCallId>/<n>` and the process is a child of the
  same pid. Stopping it ends that command and the _subagent continues with what it learned_ — verified by `node scripts/stop-probe.mjs` with
  `NESTED=1`, which is the case that motivated the whole feature (one hung command spending a child's entire time budget).
- **Two Stop controls, two icons, one row.** `card-menu.ts` owns the wording so a card and a nested row cannot disagree: the command stop is
  offered only for a live shell call with `bridge.capabilities.toolStop`, and the run-level control stays as **Abort this turn**
  (`LuOctagonX`). A nested row deliberately gets no abort control — it does not own the run.
- **The ack does not come back to the webview.** The stopped command's own result, carrying the note, is the confirmation, and a refusal is
  a VS Code toast from `runStopCommand`; the controls stay visible-but-not-pressable meanwhile (`canStopCommand` offers them,
  `canPressCommandStop` lets them fire) and a local watchdog past the host's ack budget hands them back. No new `HostMessage`, no badge state
  to retire. `turn_end` clears the board, because a run that aborted gets pi's own error result and never runs `tool_result` — and a stale
  `startedAt` **widens** the next aim rather than narrowing it.
- Verification: `pi-bridge/tool-stop.test.ts` (the aim against synthetic tables), `pi-bridge/process-tree.test.ts` (a **real** detached shell:
  group kill, grandchildren, exec'd command), and `scripts/stop-probe.mjs` for the whole chain against a live child.

## Prompt templates and skills are inserted, never sent as commands

A `source: 'prompt'` or `source: 'skill'` row of `get_commands` is a markdown file on disk, and pi expands **at most one**
per message: `expandPromptTemplate` is anchored at `^`, so a draft of `/a "x"\n/b "y"` hands `/b "y"` to `/a` as extra
arguments and an argument no placeholder reads is dropped without a word. That is why Amulet stopped shipping these commands
and started expanding them itself. Read this before changing any of it:

- **Expansion is a byte-for-byte copy of pi's, and that is the contract.** `shared/prompt-template.ts` mirrors
  `substituteArgs`/`parseCommandArgs`/`_expandSkillCommand` (`$1`, `$@`/`$ARGUMENTS`, `${1:-default}`, `${@:N:L}`, the
  non-recursive single pass, the falsy test that makes an empty argument take the default). What the dialog previews must be
  what pi would have sent, or the preview lies about the token cost. Parity is checked against the installed runtime, not
  against a paraphrase — see `shared/prompt-template.test.ts`.
- **The file is the only source of the argument shape.** `argumentHint` never crosses the wire (it is computed by pi's TUI),
  so the number of fields comes from reading the same file pi reads: `sourceInfo.path` (already on the wire, previously
  dropped by `CommandInfo`) → `src/prompts/prompt-resource.ts` → `analysePromptTemplate`. Fields = the positions the template
  actually references (capped for the form, never for the substitution) plus a `$@` field when the template reads the list.
- **Never accept a path from the webview.** The surface sends a _name_; the host resolves it in the runtime's own
  `get_commands` answer and refuses anything outside the folders pi reported (`baseDir`, `agentDir`, `<cwd>/.pi`,
  `.agents/skills`), non-`.md` paths, `builtin:` pseudo-paths, and files over `MAX_PROMPT_RESOURCE_BYTES`.
- **Client-side prose is the whole point.** Expanded text does not start with `/`, so no command dispatch, no `steer`/`follow_up`
  rejection, no `disposition: handled` with nothing to show, and no queueing race — and any number of prompts can share one
  draft. **Insert never sends**: the submit button is still the only thing that runs a turn, so the human edits and chooses.
- **Mirror pi's dispatch precedence when deciding what to intercept** (`leadingPromptCommand`): an _extension_ command of the
  same name wins (pi runs it before it expands anything), and a skill only counts when the literal `skill:` namespace was
  typed, because that is what pi's expander matches — `/pdf-tools` is prose to pi, so it stays prose here.
- **Privacy mode censors the preview, never the insertion**, like every other text leaf: paint with `useRedact()`, insert
  the untouched body the host read.
- Extension commands are untouched by all of this: the launcher, `submitText`, `reportSilentCommand` and the `longRunning`
  budget still do what `f585c7b` built them to do.

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
- **A newline the author typed is a line break in the transcript — by default.** Markdown treats a
  single `\n` as a soft break and renders it as a space, so a composer draft of `1\n2` came back as
  `1 2` and only `1\n\n2` kept the line. [`webview/src/utils/md-breaks.ts`](webview/src/utils/md-breaks.ts)
  is the one owner of the other reading: a remark plugin that rewrites soft newlines into `break` nodes,
  with `MdRender` as its only consumer and `amulet.preserveLineBreaks` (menu: **Line breaks**) choosing
  between them. Fix it there, never in the submitted text — the session file, the prompt and the
  transcript's raw copy source must all keep exactly what the author typed, and `serializeDom` already
  turns a `<br>` back into a markdown hard break.
- **The composer's keystroke path must never touch the transcript's layout.** Typing used to
  cost the whole `#chat-log`: the composer's height was published as an _inherited_ custom
  property on `documentElement`, which makes Blink recompute the style of every node in the
  conversation, and a `transition` on the `padding-bottom` that consumes it laid the log out
  once per frame for 260 ms. Four rules, all in
  [`webview/src/stores/composer-reserve-store.ts`](webview/src/stores/composer-reserve-store.ts)
  and [`webview/src/components/input-bar/input-bar/composer.tsx`](webview/src/components/input-bar/input-bar/composer.tsx):
  - reserve the log's tail by writing a **non-inherited property on the log element
    itself** (`reserveForComposer`) — never a custom property above its consumer, and never
    React state, which would re-render every turn;
  - size the textarea with `field-sizing: content` where the engine has it, and keep the
    measured fallback to one layout read (a read after a height write is a forced layout of
    the _document_, and the old code did it twice per keystroke);
  - take the height from `ResizeObserverEntry.borderBoxSize` instead of calling
    `getBoundingClientRect()` inside the observer callback;
  - memoise anything rendered inside `.input-bar` that walks `messages` (`ContextMeter`
    does) — the draft is local textarea state, so a scan of the conversation is otherwise
    paid for on every keystroke.
- The webview cannot access the microphone, filesystem, or Node APIs directly — everything goes through the host bridge.
- **Session lifetime is a prompt-cache asset.** pi rebuilds the model context from the session file
  before _every_ request, so the conversation itself never depends on the child process staying up —
  but everything in front of it is cached by the provider: the system prompt sections, the tool
  definitions, the model and the thinking level. Four rules keep that prefix intact (owning code in
  [`src/runtime/pi-runtime.ts`](src/runtime/pi-runtime.ts)):
  - switching sessions is the `switch_session` **command**, not a process restart — pi >= 1.4 answers
    it in-process (verified against 1.5.0: `{ cancelled: false }`, same PID, new `sessionFile`). The
    old "kill the child, respawn with `--session`" route survives only as the fallback for a runtime
    that does not answer, because pi 0.80.x never replied to that command.
  - `restart()`, `restartAll()` and crash recovery **resume the loaded session** (`resumeTarget()` ←
    `get_state.sessionFile`), because every restart trigger in the extension is a settings or package
    change, never a request to forget the conversation. An empty session file is deliberately not
    resumed.
  - `amulet.defaultModel` is a spawn argument for a **fresh** session only (`buildStartupArgs`).
    Command-line argv overrides the model recorded in the session file, and a model change makes pi
    drop the replayed thinking blocks — so pinning it on a resume silently moves an ongoing
    conversation to another model and forces a full prefill.
  - `client.onExit` is identity-guarded (`if (client !== this.client) return`): `stopClient()` nulls the
    client before killing it, so the exit of an intentionally retired child never enters crash recovery.
    Without it, `RpcProcess.stop()` resolving on its SIGKILL timeout lets a late exit null the current
    client and spawn a **second** live child for the same cwd — two processes appending to one session
    file and one context window.
    `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md` and installed packages/skills are therefore cache-bearing:
    pi re-reads them per prompt and folds a change into the head of the request, which costs a full
    prefill of the whole context on the next message.
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
- **The bridge bundle must be ESM (`.mjs`).** pi loads an extension with `jiti.import(path, { default: true })`, and
  an esbuild `format: 'cjs'` bundle resolves to the export _namespace_ instead of the factory, so pi refuses to
  load it (`Extension does not export a valid factory function`). `dist/pi-bridge/amulet-bridge.mjs` is the shape
  that works; verify any change with `node scripts/bridge-probe.mjs`, which drives a real child without VS Code.
- A context edit is invisible in `get_messages` from the moment it is durable, and the in-memory override that
  makes it immediate lives in the **child**: a runtime restart re-reads the bridge's sidecar
  (`amulet-context-overrides--<session>.json`, written next to the session file, never a `.jsonl`), so an edit that
  was never persisted keeps applying until its `turn_end` draft lands.
