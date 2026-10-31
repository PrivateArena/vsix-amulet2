# Pintra fork — provenance, baseline, drift

> This document keeps the upstream product name **Pintra** wherever it describes the source project
> (`bilalbentoumi/pi-vsc`). Our product is **Amulet** since 1.0.15 — see "Rebrand" below. Do not
> rename the upstream references: they are the MIT provenance record.

## Provenance

| Item | Value |
| --- | --- |
| Upstream | `https://github.com/bilalbentoumi/pi-vsc` (remote name: `upstream`) |
| Base commit | `3a2b61d` — "bump version to 1.0.5 in package.json", 2026-08-09 |
| History kept | full, 15 commits, tags `v1.0.1`–`v1.0.5`, branch `main` |
| Our remote | **not created yet** — `gh` is authenticated as `gunir`; a GitHub-side fork is still pending (see Open decisions) |
| Layout | fork lives **at the repo root** of `vsix-amulet2` (no subdirectory); our own notes (`DRAFT.md`, `PROJECT_OVERVIEW.md`, `docs/`) are the only non-upstream paths |
| Licence | `MIT` per `package.json:17` and `README.md:51`, but upstream **shipped no LICENSE file**. Added `LICENSE` (upstream copyright preserved) in the first fork commit; `vsce` no longer warns |

Upstream is 15 commits over ~3 weeks and quiet since 2026-08-09 (~2.7 months). All upstream
history is retained so upstream fixes can still be merged: `git fetch upstream && git merge upstream/main`.

## Why this base (supersedes the `vscode-tauren` decision)

Empirical, after running all candidates: Pintra is the only one with a **first-class editor-tab
frontend** (`src/editor/panel-manager.ts`, command `pintra.openChatInEditor`) in addition to the
sidebar `WebviewViewProvider`. Sidebar-only bases cap the chat at panel width.

Structurally it is also the cheapest fork of the five:

- ~4.4k LOC of TS/TSX across `src/` + `webview/src/` + `shared/` — one weekend of reading, not one week.
- The `pi` runtime is **not bundled**: the host spawns `pi --mode rpc` and speaks JSON-lines over stdio
  (`src/rpc/`). So there is **no SDK version pin** and no `0.80.x → 1.4.0` migration spike — the
  runtime updates independently of the extension.
- Toolchain: esbuild (two targets: CJS host, IIFE React webview), React 18, zustand, sass, vitest.
  No framework rewrite needed.

## Verified baseline (2026-10-30, this machine)

| Gate | Command | Result |
| --- | --- | --- |
| Install | `npx pnpm@10 install` | OK, 7s |
| Types | `pnpm typecheck` (`tsc --noEmit`) | clean |
| Dev build | `pnpm build` | `dist/extension.js` 67kb, `dist/webview.js` 2.4mb |
| Tests | `pnpm test` (vitest) | 2 files, 22 tests passed |
| Package | `pnpm package` | `pi-vsc-1.0.5.vsix`, 24 files, 1.53MB |

Gotcha: `pnpm-workspace.yaml` uses `allowBuilds`, a **pnpm 10** key; pnpm 9 aborts with
"packages field missing or empty". Use pnpm 10 (`npx pnpm@10 …`). Consider pinning `packageManager`
in `package.json` — upstream does not.

## Dependency drift vs `pi` 1.4.0 (installed: 1.4.0, npm latest: 1.4.0)

Checked the client's RPC surface against the authoritative types shipped by the runtime at
`@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`:

- **No breakage.** Every command Pintra sends exists in 1.4.0; Pintra uses a strict subset (31 of 33).
- **Unused runtime capability** — `clear_queue`. (`get_available_thinking_levels` is now wired up: see
  "Thinking level contract" below.)
- **Events Pintra does not model** (present in `core/agent-session.d.ts`): `agent_settled`,
  `entry_appended`, `queue_update`, `bash_execution_update`, `summarization_retry_*`. Events fan out
  through `PiRuntime.dispatchEvent` (`src/runtime/pi-runtime.ts:61,117`) to typed listeners, so
  unknown events are ignored rather than fatal — but the missing ones are why live bash output and
  queue state look thin. Likely the same class of bug as the reported display issues.
- **Stale comments** claiming pi 0.80.x hangs on `switch_session`: `src/runtime/pi-runtime.ts:275`,
  `src/runtime/bootstrap.ts:120`. Those workarounds must be re-tested against 1.4.0 and deleted if
  they are no longer needed — they are the only places the fork still "thinks" it is on 0.80.x.

## Verified protocol drift vs pi 1.4.0 (2026-10-30, live capture)

Capture method: `node scripts/rpc-probe.mjs "<prompt>"` from a scratch workspace — it spawns
`pi --mode rpc` exactly like the host does and appends every wire event to `tmp/rpc-events.jsonl`.
Three real runs (plain reply, bash tool call, command sweep). Findings, all of them upstream
assumptions about pi 0.80.x:

1. **`message_start`/`message_end` fire for `role: "system"` and its `content` is a *string***
   (`""` — the prompt text moved to `content.sections`). `system` is a displayable role, so the
   reducer put that string into `UiMessage.content` (`content: msg?.content ?? m.content`) and
   `agent-timeline.tsx` died on `m.content.forEach` — the whole chat view fell into the error
   boundary on every submit. Fixed by `normalizeContent()` in `shared/blocks.ts`, applied at every
   store write, plus defensive normalization at the two render sites. Same shape in `get_messages`
   history (`[system:string, user:[text], assistant:[…], toolResult:[text], …]`).
2. **`message_update` no longer carries `message`.** The runtime strips the cumulative snapshot
   (`pi-coding-agent/dist/modes/json-event.d.ts`) and sends `{ usage, assistantMessageEvent }`
   deltas (`text_*`, `thinking_*`, `toolcall_*`, keyed by `contentIndex`; `toolcall_start` adds
   `id`/`toolName`, `toolcall_end` adds the finished `toolCall`). The old reducer bailed on the
   missing `message`, so nothing rendered while streaming. `applyAssistantEvent()` now folds the
   deltas into blocks (streamed tool args accumulate in `ToolCallBlock.partialArgs`); `message_end`
   still wins as the authoritative payload, and the legacy snapshot path is kept for older runtimes.
3. **`switch_session` responds normally on 1.4.0** (`data.cancelled`) — the "0.80.x handler hangs"
   comment in `src/runtime/pi-runtime.ts:273` and `src/runtime/bootstrap.ts:120` is stale, and the
   stop/restart workaround it justifies can now be deleted. Still to do.

Other wire shapes observed and confirmed compatible: `tool_execution_end.result` =
`{ content: blocks[], structuredContent }`; new unhandled events `turn_start`, `turn_end`,
`agent_settled`, and `extension_ui_request` `setStatus` (emitted in a loop by the `pi-gate`
extension; `src/webview/extension-ui.ts` already ignores it correctly).

Version bump: `1.0.5` → `1.0.6` so the running build is identifiable in the welcome screen and in
the installed-extension folder name.

## Nested tool calls (subagent commands) — wire contract

A tool that runs other tools through `ctx.executeTool()` (the `subagent` tool from
`pi-disciple`, pi's `codemode`) makes **every child call visible on the parent's RPC
stream** as ordinary `tool_execution_start/update/end` events carrying
`parentToolCallId`, with the child id being `<parentToolCallId>/<n>` — see
`pi-coding-agent/dist/core/nested-tool-calls.d.ts`. Verified by capture
(`scripts/rpc-probe.mjs` with a prompt that spawns a subagent): the events carry the
child's real `args` (full bash commands), `partialResult.content` (live output),
`isError` and `durationMs`. Capture method and replay-into-`reducer()` are covered by
the `reducer — nested (subagent) tool calls` suite in `webview/src/store.test.ts`.

Three facts that are easy to get wrong:

1. `message.nestedCalls` (on the settled `role: "toolResult"` message, and in
   `get_messages`) is `{ calls: NestedToolCallRecord[], complete: boolean }` — pi's
   bounded record (256 calls, 8 KB/call, 32 KB total; oversized args come back as
   `argumentsBytes` only). **Outputs are not persisted**, so a reloaded card lists the
   calls without expandable results.
2. `details.nestedCalls` inside the subagent payload is a **number**; do not conflate
   it with `message.nestedCalls`.
3. pi's own TUI deliberately does not draw nested calls (`interactive-mode.js` skips
   events with `parentToolCallId`), so the renderer is ours. `details` carries
   `{ status, exit, report, pendant: { title, subtitle }, tokens, turns, toolCalls,
   activity, elapsedMs, childSessionFile, childSessionId }` — `elapsedMs` is the
   preferred source for a running card's elapsed time; without it a card counts from
   its own `tool_execution_start` (`ToolExec.startedAt`), which is all any other tool
   has.

Rendered in `webview/src/components/exec-view/subagent-calls/` (call list + report)
inside the existing `ExecBlock` card; state lives in `ToolExec.childIds` /
`parentToolCallId` / `details` on `webview/src/store.ts` — nested entries never become
message blocks, so they cannot leak into the timeline as top-level rows. Display
mapping (labels, one-line previews, durations) moved to `exec-view/tool-display.ts` so
the child rows and the parent header render identically.

Every card header ends in the same cluster: elapsed time, then hover-only Copy (the
tool's full command or path, which the ellipsized preview cannot give back) and, while
the call is live, Stop. Stop posts the existing `abort` host message — pi has no
per-tool cancel, only the run-level signal handed to `execute()`, which a tool may
ignore until it settles — so an aborted call comes back as an error result, and a card
the runtime never reported on shows no cluster at all: aborting *it* would only hit
whatever else is running.

## Known gaps for the next session

1. **Display issues in the editor-tab frontend** — the reported bug class. Start at the layout map:
   `src/webview/webview-surface.ts` (shared surface factory), `src/provider.ts` (sidebar),
   `src/editor/panel-manager.ts` (tabs), then `webview/src/assets/css/*.scss` and
   `webview/src/components/**` (`agent-timeline.scss`, `message-view.scss`, `input-bar.scss`,
   `message-list.scss`) for sidebar-width assumptions.
2. **Multi-surface state**: one `SessionManager` pool feeds N `ChatBridge` instances
   (`src/webview/chat-bridge.ts`, 865 lines — the largest file). Audit which per-surface state is
   actually global before changing it.
3. **Rebrand to Amulet** — done (2026-10-31, v1.0.15). Extension id is now `gunir.amulet`, so the vsix
   no longer collides with the marketplace Pintra. What moved:
   - `package.json`: `name` `pi-vsc` → `amulet`, `publisher` → `gunir`, `repository` →
     `github.com/gunir/vsix-amulet2` (repo keeps its working name for now), artifact glob in
     `vscode:install` → `amulet-*.vsix`. Artifact is derived from `name` by `scripts/build-vsix.sh`.
   - All `pintra.*` ids: commands, `amulet-container`/`amulet.chatView`, `onView:` activation event,
     `amulet.chatEditor` (code-only, not in the manifest), and the `SECTION` constant in
     `src/config.ts` which drives the 8 `amulet.*` settings keys. **Existing user settings do not
     migrate** — a renamed id means a fresh install, so there is nothing to migrate anyway.
   - `--pintra-*` design tokens → `--amulet-*` (128 tokens, 30 `.scss` files) and the `@font-face`
     families `Pintra Mono`/`Pintra Pixel` → `Amulet Mono`/`Amulet Pixel`, which cross the
     host (`src/webview/html.ts`) → SCSS (`variables.scss`, `logo-text.scss`) boundary.
   - User-visible brand strings, the `PINTRA` wordmark (`logo-text.tsx`, still 6 letters), the output
     channel name (`createOutputChannel('Amulet')` ⟷ `amulet.showLog` ⟷ `error-boundary.tsx` prose).
   - Extension-id references that contain no brand text and so are invisible to a brand grep:
     `'@ext:bilalbentoumi.pi-vsc'` in `src/webview/chat-bridge.ts` and `REPO_URL` in
     `webview/src/components/topbar/settings-menu/settings-dropdown.tsx`. Both now read `gunir`/`amulet`.
   - Logo: the blocky `P` mark became a symmetric `A` on the same 270-unit grid (60-unit stems, 150×90
     counter). Three hardcoded copies of the path — `media/icon.svg`, `media/activity-bar-icon.svg`
     (translated +80/+80 into the 430 viewport) and `webview/src/components/logo-icon.tsx` — plus a
     re-rasterised 430×430 `media/icon.png` (opaque black, pure white glyph, hard edges, artwork at
     80..349, exactly like the original export).
   - `.github/FUNDING.yml` now points at `gunir` instead of upstream's sponsor list.
   **Still to do:** `media/screenshot.png` pixels still show the old wordmark.
4. **Test story**: two vitest files only — `shared/blocks.test.ts` (block reconstruction) and
   `webview/src/store.test.ts`; AGENTS.md says "there is no test suite" for behaviour. Host↔webview changes need a manual F5 pass.
5. **Lineage hygiene** (carried over from `vsix-amulet`): `../vsix-amulet/extension/` is EULA'd —
   study only, never copy. Keep Pintra-derived commits clearly separated from any Pendant-derived work.

## Open decisions

- Create the GitHub fork under `gunir` (or an org?) and set it as `origin` — one command:
  `gh repo fork bilalbentoumi/pi-vsc --clone=false --remote-name=origin`. `origin` currently points at
  the private `PrivateArena/vsix-amulet2`, which is why the README badges may render "unknown" until a
  public `gunir/vsix-amulet2` exists.
- ~~New extension id / display name / publisher for the Amulet build.~~ Decided: `gunir.amulet`,
  displayName "Amulet — Pi Agent for VS Code", version line kept at 1.0.x.

## Thinking level contract (pi 1.4.0, verified against the installed runtime)

Verified by driving `pi --mode rpc` directly (`get_state`, `get_available_thinking_levels`, `set_model`)
and reading `dist/core/agent-session.js` + `pi-ai/dist/models.js`:

- The **harness owns the level list**. `get_available_thinking_levels` → `{ levels: ThinkingLevel[] }`,
  built by `getSupportedThinkingLevels(model)` from the model's `thinkingLevelMap`: `null` entries drop a
  level, `xhigh`/`max` appear only when explicitly mapped, and a model with `reasoning: false` gets
  `["off"]`. The webview picker renders exactly this list — never a hard-coded menu — and only falls
  back to the shared preset when pi answers "unknown command" (the command shipped in pi **0.81.0**).
- `get_state.thinkingLevel` is **optional in our type**: the runtime omits it until something applies a
  level (verified live — a fresh session on a non-reasoning model reports no `thinkingLevel` at all),
  and the provider default then applies. pi's own `rpc-types.d.ts` declares the field required, so do
  not "fix" the optionality. The picker shows the unset state as **Disabled** and says "…" until the
  first `get_state` arrives.
- `set_thinking_level` clamps to the available list (`clampThinkingLevel`), so sending a level the model
  does not map silently changes it to a neighbour. Do not "help" by re-mapping client-side.
- **pi emits no model-changed event on the wire** (`model_select` goes to the extension runner only,
  `core/agent-session.js:1992`). The capability list therefore travels with every host-initiated model
  change — `setModel`, `cycleModel`, `newChat`, `editAndFork`, `switchSession`/`restart` (via
  `pushSnapshot`), provider-login restart — plus the fetch-on-open in the picker.
- Startup: `amulet.thinkingLevel` defaults to `disabled`, which sends **nothing** (previously the host
  always sent `medium`, overriding pi's `defaultThinkingLevel`, per-model levels, and the resumed
  session). Any concrete value is applied per runtime start and live on the setting change
  (`applyThinkingLevelSetting`); `disabled` itself only takes effect on the next runtime start because
  pi has no "unset" command.

## Context meter contract (pi 1.4.0)

The ring in the composer toolbar reads one value: how much of the model's window the **next** request
will need. Two rules keep it honest and live:

- **The host owns `SessionStats`.** `pushStats` in `src/webview/chat-bridge.ts` is the only producer
  (`get_session_stats` → `{ type: 'stats' }`). It fires on the connect snapshot, `newChat`, `compact`,
  `requestStats`, and from `onRuntimeEvent` on `turn_end`, `agent_end` and `compaction_end`. `turn_end`
  is the important one: a run is many turns (one LLM call + its tool results), so refreshing per turn
  is what moves the meter during a long run. **Do not poll it per delta** — `getSessionStats()` walks
  a copy of every session entry inside pi (and one bridge per open panel means one walk per bridge).
- **The webview fills the gap inside a turn.** pi only counts *persisted* messages, so the last
  `get_session_stats` answer is already stale while the model is writing. `contextUsage.tokens` is just
  `totalTokens || input + output + cacheRead + cacheWrite`, and that same `usage` rides on `message_end`
  — and on the last few `message_update` deltas, per the `tmp/rpc-events-tool.jsonl` capture; every
  earlier delta carries an all-zero `usage`. So `contextUsageOf`
  (`webview/src/components/input-bar/ctx-meter/context-usage.ts`) recomputes the figure from the
  streaming message, a beat ahead of the host's round-trip, with pi's own arithmetic — no visible jump
  when `agent_end` delivers the authoritative value. The all-zero deltas are filtered out so the ring
  never empties at the start of a run.

  Consequence: the meter **steps once per LLM call, not once per token**. Providers report usage only
  when a message finishes, so nothing on the wire describes the middle of a generation; filling that in
  with a character-count estimate would make the meter disagree with pi's own `/context` reading.

`contextUsage` is **optional at runtime** (absent with no resolved model, `{ tokens: null }`-shaped
right after a compaction), so the meter derives `percent` from `tokens / contextWindow` itself, ignores
pi's `percent`, and renders nothing when the window is unknown. Switching models changes the window,
hence `setModel`/`cycleModel` re-push stats.
