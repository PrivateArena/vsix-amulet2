# Pintra fork — provenance, baseline, drift

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
- **Unused runtime capability** — `clear_queue`, `get_available_thinking_levels`. Free features to adopt.
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

## Known gaps for the next session

1. **Display issues in the editor-tab frontend** — the reported bug class. Start at the layout map:
   `src/webview/webview-surface.ts` (shared surface factory), `src/provider.ts` (sidebar),
   `src/editor/panel-manager.ts` (tabs), then `webview/src/assets/css/*.scss` and
   `webview/src/components/**` (`agent-timeline.scss`, `message-view.scss`, `input-bar.scss`,
   `message-list.scss`) for sidebar-width assumptions.
2. **Multi-surface state**: one `SessionManager` pool feeds N `ChatBridge` instances
   (`src/webview/chat-bridge.ts`, 865 lines — the largest file). Audit which per-surface state is
   actually global before changing it.
3. **Rebrand to Amulet**: `package.json` `name`/`publisher`/`private: true`, extension ids
   `pintra.*` in `contributes` + every `src/commands.ts` handler, config keys in `src/config.ts`,
   `.github/FUNDING.yml` (still points at upstream's sponsor list). Note the extension id is
   `publisher.name`, so the current vsix collides with the marketplace Pintra until renamed.
4. **Test story**: two vitest files only — `shared/blocks.test.ts` (block reconstruction) and
   `webview/src/store.test.ts`; AGENTS.md says "there is no test suite" for behaviour. Host↔webview changes need a manual F5 pass.
5. **Lineage hygiene** (carried over from `vsix-amulet`): `../vsix-amulet/extension/` is EULA'd —
   study only, never copy. Keep Pintra-derived commits clearly separated from any Pendant-derived work.

## Open decisions

- Create the GitHub fork under `gunir` (or an org?) and set it as `origin` — one command:
  `gh repo fork bilalbentoumi/pi-vsc --clone=false --remote-name=origin`.
- New extension id / display name / publisher for the Amulet build.
