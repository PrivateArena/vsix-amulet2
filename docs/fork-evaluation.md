# Fork evaluation — Pi-in-VS-Code candidates for the Amulet redesign

> **SUPERSEDED (later, same day).** The recommendation below (`kaiwood/vscode-tauren`) was overturned by
> hands-on testing: **Pintra** (`bilalbentoumi/pi-vsc`) — a sixth candidate, not covered by this study —
> was forked instead, because it is the only one with an editor-tab chat frontend. See
> `docs/pintra-fork.md`. Kept for the evidence trail on the other five.

Task from `DRAFT.md`: pick one of five open-source VS Code + Pi integrations to fork as the
foundation for Amulet, instead of continuing to clean-room the closed-source Pendant payload.

Clones (2026-10-30 snapshot, shallow-free): `/tmp/pi-forks/{Avhatar/pi-vscode-extension-avr,Printaga/PiLot,gnassro/phi,quincycs/pi-qcode,kaiwood/vscode-tauren}`
Upstream reference: `@earendil-works/pi-coding-agent` **1.4.0** (published 2026-10-21).

## Verdict

**None of the five is a safe wholesale fork base.** Each fails at least one of the four critical
requirements, and none of them has the process model Amulet already runs. The two that score well
score well on _opposite_ axes:

|                           | strongest                                                                 | fatal flaw                                                                           |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **kaiwood/vscode-tauren** | architecture, code quality, docs, product polish, vanilla-TS webview      | dormant since **2026-08-30**, SDK pinned **0.80.10** (oldest)                        |
| **Printaga/PiLot**        | **only repo on SDK 1.4.0**, most recent push (2026-10-29), real 3-lane CI | 4,090-line god file, untyped 38 KB CJS entry, Svelte 5 webview, no architecture docs |

**Recommendation: fork `vscode-tauren` as the structural base, and graft Amulet's existing worker
under its `PiClient` port.** Take currency from PiLot, protocol validation from avr, protocol
reference docs from phi, envelope discipline from qcode. Details in [Plan](#plan).

## Evidence table

|                                 | avr / "pi-code" 0.73.0                                                                                      | PiLot 3.0.1                                                       | phi 0.9.1                                                             | pi-qcode 0.1.9                       | tauren 1.10.0                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| Stars / forks                   | 4 / 1                                                                                                       | 9 / 0                                                             | 17 / 6                                                                | 18 / 1                               | 38 / 9                                                                               |
| Last push                       | 2026-09-20                                                                                                  | **2026-10-29**                                                    | 2026-10-11                                                            | 2026-10-21                           | ⚠️ 2026-08-30                                                                        |
| Commits (since Jul 1)           | 234 (114)                                                                                                   | 123 (75)                                                          | 135 (34)                                                              | 122 (51)                             | **694 (71)**                                                                         |
| Commit hygiene                  | atomic                                                                                                      | mostly, some churn                                                | PR pairs                                                              | `V0.1.9`, `draft`, `plan35`          | atomic                                                                               |
| Tags / CHANGELOG                | 1 tag / 119 KB log                                                                                          | 5 tags / kept                                                     | tags / kept                                                           | **none / none**                      | tags / Keep-a-Changelog                                                              |
| License                         | MIT                                                                                                         | **Apache-2.0** + `src/NOTICE.md`                                  | MIT                                                                   | MIT                                  | MIT                                                                                  |
| Pi SDK                          | 0.85.1 (deps)                                                                                               | **1.4.0** (devDep)                                                | 1.0.4 (deps)                                                          | **none** — rides user CLI            | 0.80.10 (devDep, bundled)                                                            |
| Process model                   | SDK **in extension host**                                                                                   | SDK in host, loaded from user's global install via `require` hook | SDK in host                                                           | **drives `pi` in a terminal**        | SDK in host (bundled)                                                                |
| Prod LOC (src, non-test)        | ~52 k                                                                                                       | ~32 k TS+Svelte                                                   | 3.8 k TS + 7.4 k **JS**                                               | 12 k TS (HTML in strings)            | ~51 k                                                                                |
| Webview stack                   | vanilla TS, `main.ts` **6,088 lines, excluded from tsc**                                                    | **Svelte 5**                                                      | plain **JS**                                                          | template-string HTML                 | **vanilla TS, 43 files**                                                             |
| `any` (non-test) / `@ts-ignore` | 243 / 0                                                                                                     | 141 / 0 (+38 KB untyped CJS)                                      | 8 / 0                                                                 | 0 / 0                                | **0 / 0**                                                                            |
| Lint/format                     | none                                                                                                        | eslint+prettier+husky+fallow                                      | `lint` script with **no config**                                      | none                                 | none (fallow)                                                                        |
| Tests                           | 141 vitest (Electron lane not in CI)                                                                        | **42 files, 3 lanes, in CI + E2E**                                | **0**                                                                 | 23 `node:test`, never in CI          | 75 mocha, **all need real VS Code, no CI**                                           |
| Docs                            | 52 KB README w/ architecture §, **81-file wiki** — but depends on private `standalone/` submodule (**404**) | 9.5 KB README, no architecture                                    | 14 KB architecture + **14 KB IPC protocol** + **27 KB SDK migration** | 7 KB user README                     | VitePress site, **3 ADRs**, 33 md                                                    |
| Distinctive feature             | subagents + **git-worktree write isolation**, checkpoints, LSP, MCP                                         | **MCP panel**, voice, commit-message gen, CI/audit                | single-importer rule, cost monitor                                    | versioned token-auth bridge protocol | **`PiClient` port**, session tree nav, session diffs, trace-origin, custom-UI bridge |

### Screenshots (what each project chose to showcase)

- **avr** — chat as an _editor tab_ + launcher sidebar: Plan Mode toggle, File Undo view, ToDo 7/7,
  Subagents, History 8, Tools 21/22, thinking blocks, per-turn token/turn/speed footer, context meter
  `52.4k / 272.0k · 19%`, `cache: auto-long`, `thinking: high`. Densist feature surface; visually utilitarian.
- **PiLot** — branded dark-blue sidebar: model/thinking header, Session Context with `1 Files · 9 Skills · 8 Packages`,
  voice + attach composer, `IN / OUT / CACHE / TOTAL` counters. Product-grade GUI, thinnest internals.
- **phi** — single right-hand chat panel, per-message cost (`$0.0357`), `4% context`, thinking disclosure. Minimal.
- **tauren** — the most finished UI: expandable tool cards, inline images, session **lanes** (`IDLE · 34 · 7k/272k · gpt-5.5 · low · +35 −15`),
  **Steer / Follow-up**, and a _Changes_ view with reasoning + verified-checklist + `+77 −12` and an
  `Origin: cli:nt45` traceability chip. Only project showing code→session→git provenance.
- **qcode** — **no image assets in the repo**; README promises "screenshots and video at the bottom" that are not there.

## Why not "just use one of them"

1. **All five put the Pi runtime inside the VS Code extension host** (or, for qcode, drive a terminal).
   tauren _migrated away from_ process isolation — `docs/decisions/0001-sdk-over-rpc.md` — and lists the
   consequences it accepted: _"Pi runtime now shares the VS Code extension host process"_, _"plugin/runtime
   issues can affect Tauren more directly"_. Amulet's forked worker (`../vsix-amulet/amulet/src/worker/`,
   5.9 k LOC, on SDK **1.4.0**, single-declaration `shared/protocol.ts`, 5 passing suites incl. a `.vsix`
   that re-runs integration tests against the packaged files) is **ahead of all five on the axis that
   matters most for a long-lived product**. Forking any of them means giving that up.
2. **Requirement conflict is real.** "Up to date / active" selects PiLot; "clean, structured, well-documented"
   selects tauren; the union is empty. PiLot would additionally force a Svelte 5 webview and a
   `require`-hook loader that resolves the SDK from the user's global `pi` install — a different runtime
   contract from Amulet's bundled-worker one, and it cannot host Pi TUI extension UI as cleanly.
3. **avr is not forkable as documented.** Its advertised second host is a git submodule pointing at
   `Avhatar/pi-code-standalone`, which returns **HTTP 404**. Its branching story is also incomplete:
   `src/pi/session.ts:796 navigateTree: async () => ({ cancelled: false })` is a no-op.
4. **qcode's model is the wrong one** — a terminal driver plus re-parsing of Pi's on-disk JSONL
   (`src/sessionFiles.ts`) is hidden coupling to Pi internals, worse than an SDK dependency.

## Plan

**Base: `kaiwood/vscode-tauren` (MIT).** It is the only codebase whose shape Amulet can adopt without
rewriting: strict TS (`strict + noUnusedLocals + noUnusedParameters`), **0 `any`**, 0 `@ts-ignore`, 0 TODO,
0 files importing `vscode` inside `src/sdk`, `src/pi`, `src/sessions`, `src/webview`, `src/agent`,
`src/webviewProtocol`; a 46-method transport-agnostic `PiClient` port (`src/pi/clientTypes.ts:27-73`)
with two adapters already proving the seam (`src/sdk/piSdkClient.ts`, `src/kward/kwardClient.ts`); a
single host↔webview protocol module (`src/webviewProtocol/types.ts`, parsed from `unknown` at
`src/sidebar/chatWebview.ts:26`); and a **vanilla-TS DOM webview** — Amulet's stated constraint.

Steps:

1. **Go/no-go spike (1 day).** Bump tauren's bundled SDK `0.80.10 → 1.4.0` with its own
   `scripts/update-pi-sdk.js` + `scripts/verify-pi-sdk-peer-runtime.js`, and get `npm run compile &&
npm test` green under Electron. The SDK surface tauren touches is small and enumerable
   (`SettingsManager`, `SessionManager`, `createAgentSessionRuntime`, `createAgentSessionServices`,
   `createAgentSessionFromServices`, `AgentSessionEvent`, `ModelRuntime`). **If the jump is cheap → fork
   tauren. If it is not → fork PiLot instead** and accept Svelte + dismantling
   `src/pi-agent-provider.ts` (4,090 lines).
2. **Re-insert Amulet's worker as the third `PiClient` adapter** (crash isolation, bounded restart onto
   the same session file). This is the single highest-value change and no candidate has it.
3. **Adopt** tauren's diff lifecycle (`src/diff/`), session tree/fork/clone, trace-origin
   (`src/origin/`), custom-UI/widgets bridge (`src/extensionUi/`, `src/webview/customUI/`) and its ADR
   practice — Amulet's roadmap M4/M5/M6 lands directly on those modules.
4. **Mine, do not merge:**
   - `avr` — `src/shared/connection-protocol.ts`, `protocol-runtime.ts` (TypeBox, `additionalProperties:false`),
     `agent-connection-client.ts` (sequence numbers + event-epoch recovery) → upgrade Amulet's
     `shared/protocol.ts` from compile-time to runtime-validated; `src/pi/subagents/write-isolation.ts`
     (worktree isolation) and checkpoint/redo for Amulet M7.
   - `PiLot` — SDK 1.4.0 usage, `src/mcp-manager.ts` + MCP panels, `src/git-commit-message.ts`, and its
     CI lane split (unit / jsdom / real-host E2E / `osv-scanner` audit) — the best CI of the five.
   - `phi` — `docs/ipc-protocol.md`, `docs/pi-sdk.md`, and the `AGENTS.md` rule listing every place to
     update on an SDK migration (phi is the only repo with a written SDK-migration procedure).
   - `qcode` — `src/piBridgeProtocol.ts` (protocol version, record/message size caps, sequence numbers,
     token auth, idempotent registration) as the envelope spec for the Amulet worker channel.
5. **Reject outright:** Svelte (PiLot) unless the spike forces it; terminal-driving (qcode); in-host SDK
   everywhere; avr's 90 MB unpruned dependency bundle and its un-forkable `standalone` half.

## Known risks

- tauren dormancy: 2 months without a commit is not abandonment (not archived, external PRs merged to
  the end), but the fork inherits the SDK drift it stopped absorbing.
- Apache-2.0 (PiLot) is fork-friendly but requires retaining `src/NOTICE.md` and stating changes —
  unlike the four MIT repos.
- tauren's tests only run inside a real VS Code window: adopting it means writing a CI lane before
  trusting any change, which is step 1's prerequisite in practice.
