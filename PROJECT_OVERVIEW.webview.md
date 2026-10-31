<!-- codegraph-file-count: 116, last-commit: 9906c564187081c7c29dc2c84afd21928a102193 -->

# Amulet webview bundle v1.0.22 — TypeScript / React 18 (browser IIFE, no Node built-ins)

## Purpose

Scope file for `webview/` (116 files) — the chat UI that VS Code loads as `dist/webview.js`. It renders
the streaming `pi` conversation (assistant text, thinking, tool calls, nested subagent calls), the composer
(model / thinking-level / context meter / slash commands / attachments), session management, provider login,
and pi-extension approval dialogs. It talks to the host **only** through `postMessage` using
`WebviewMessage` / `HostMessage` from `shared/protocol.ts` — importing `vscode` here breaks the bundle.
Host side: **PROJECT_OVERVIEW.md**.

## File Tree

```
webview/src/main.tsx            createRoot + StrictMode + ErrorBoundary -> App
webview/src/App.tsx             ChatCtx provider + Shell + modal overlays
webview/src/app-shell.tsx       Shell: onHostMessage -> dispatch({type:'host'}), screens, global keys
webview/src/store.ts            ChatState + reducer + applyRpcEvent (the wire->UI fold)
webview/src/apis/               vscode.ts (postMessage/onHostMessage), actions.ts (typed senders)
webview/src/contexts/           chat-context.tsx (useReducer(state, dispatch) + useChatState)
webview/src/screens/            splash-screen.tsx (no runtime/auth), session-screen.tsx
webview/src/stores/             zustand: composer-store, confirm-store, provider-login-store,
                                session-info-store, turn-nav-store
webview/src/components/entry-list/    message-list.tsx (scroll + stick-to-bottom host)
webview/src/components/entry-view/    agent-timeline.tsx (blocks -> rows), message-view.tsx
webview/src/components/exec-view/     tool-call-view.tsx, tool-display.ts, subagent-calls/
webview/src/components/input-bar/     input-bar/composer.tsx, model-picker/, ctx-meter/,
                                      cmd-menu/, reasoning-select/
webview/src/components/topbar/        topbar/, topbar-left/, topbar-right/, settings-menu/
webview/src/components/ui/            permission-prompt/, auth-dialog/, session-info-dialog/,
                                      modal/, flyout/, tooltip/, ctx-menu/, button/, menu-item/, ld/
webview/src/components/chat-find/     chat-find.tsx, transcript-index.ts, find-query (utils)
webview/src/components/               code-block/, patch-view/, reasoning-block/, progress-bar/,
                                      session-dd/, session-grid/, md-render.tsx, error-boundary.tsx
webview/src/{hooks,utils,constants,libs}/ + assets/css/  (--amulet-* tokens, per-component *.scss)
```

## Component Roles

| File / Module | Role | LOC | Key Exports (signatures) |
|---|---|---|---|
| webview/src/store.ts | Chat state, one reducer, RPC-event folding, tool/nested-call bookkeeping | 563 | `reducer(state: ChatState, action: Action): ChatState`, `applyRpcEvent(state: ChatState, event: RpcEvent): ChatState`, `seedToolsFromHistory(messages: AppMessage[]): Record<string, ToolExec>`, `toUiMessage(m: AppMessage): UiMessage` |
| webview/src/app-shell.tsx | Wires host messages into the reducer; owns fork mode + Esc/abort rules | ~330 | `Shell()` — Props: none; Hooks: `useChatState`, `useChatDispatch`, `onHostMessage` |
| webview/src/contexts/chat-context.tsx | Chat state + dispatch via React context (not zustand) | 37 | `ChatCtx({children}: {children: ReactNode})`, `useChatState(): ChatState`, `useChatDispatch(): Dispatch<Action>` |
| webview/src/apis/vscode.ts | The only `acquireVsCodeApi` boundary | 25 | `postMessage(message: WebviewMessage): void`, `onHostMessage(handler: (m: HostMessage) => void): () => void` |
| webview/src/apis/actions.ts | Named senders so components never hand-build messages | 79 | `actions` — `{ sendMessage, steer, abort, setModel, switchSession, compact, updatePi, ... }` |
| shared/blocks.ts (used here) | Content normalization + delta folding, applied at every store write | 214 | `normalizeContent(content: unknown): ContentBlock[]`, `applyAssistantEvent(blocks, event?): ContentBlock[]` |
| components/entry-list/message-list.tsx | Transcript scroller, streaming caret, load/scroll behaviour | ~180 | `EntryList({ onScrollAtBottomChange?: (atBottom: boolean) => void })`; Hooks: `useChatState`, `useStickToBottom` |
| components/entry-view/agent-timeline.tsx | Messages + tools -> flat render items (text/thinking/tool/system/caret) | 147 | `buildItems(messages: UiMessage[], tools: Record<string, ToolExec>): TimelineItem[]`, `AgentTimelineProps` |
| components/entry-view/message-view.tsx | One message: markdown, copy, edit/fork affordances | 236 | `MessageView(...)`; Hooks: `useChatState`, `confirm` |
| components/exec-view/tool-call-view.tsx | Tool card: header cluster (elapsed / Copy / Stop) + expandable output | 342 | `ToolCallView(...)`; Hooks: `useChatState`, `useTickingClock` |
| components/exec-view/tool-display.ts | Shared display mapping so child rows and parent header match | 258 | `toolPreview(name: string, args: unknown): string`, `toolDuration(tool?: ToolExec, now: number, preferredMs?: string)`, `tipHead/tipTail(text, maxLines, maxChars)`, `childCalls(tool?, tools?): ToolExec[]` |
| components/exec-view/subagent-calls/subagent-details.ts | Sole reader of the subagent payload (`args.task`/`prompt`/…, `details`) | 163 | `resolveSubagentCard(name: string, details: unknown, args: unknown): SubagentDetailsView \| null`, `subagentPrompt(args, details?): string` |
| components/exec-view/subagent-calls/subagent-calls.tsx | Nested call list + report inside the parent card | 227 | `SubagentCalls({ calls, tools, details, report, status, complete })` |
| components/input-bar/input-bar/composer.tsx | Textarea, slash-command insertion + chaining, attachments, submit/steer | 398 | `Composer(...)`; Hooks: `useComposerStore`, `useSlashCommands` |
| components/input-bar/model-picker/model-dropdown.tsx | Model list from the host (`models` HostMessage), provider grouping | 481 | `ModelDropdown(...)`; Hooks: `useChatState`, `useClickOutside` |
| components/input-bar/ctx-meter/context-usage.ts | Intra-turn token estimate from streaming `usage` | 72 | `contextUsageOf(stats: SessionStats \| null, messages: UiMessage[]): ContextUsageView \| null`, `contextTokensOf(usage?: Usage): number \| null` |
| components/input-bar/ctx-meter/context-stats.tsx | Ring + tooltip rendering of that figure | ~120 | Props: none; Hooks: `useChatState` |
| components/ui/permission-prompt/permission-prompt.tsx | Renders `pendingUi[0]`; answers exactly once, Esc = cancel = deny | 258 | `PermissionPrompt()`; Hooks: `useChatState` |
| components/ui/permission-prompt/ui-response.ts | Exact wire shape of dialog replies | 78 | `buildUiResponse(req: Pick<ExtensionUiRequest,'id'\|'method'>, answer: UiAnswer): ExtensionUiResponse` |
| components/ui/auth-dialog/provider-login-dialog.tsx | Subscription/API-key/device login flow | 439 | `ProviderLoginDialog(...)`; Hooks: `useProviderLoginStore` |
| components/chat-find/chat-find.tsx | In-transcript find bar (case/regex, next-prev) | 310 | `ChatFind({ containerRef, onReveal }: ChatFindProps)` |
| components/chat-find/transcript-index.ts | DOM text-node index + `Range` highlight painting | 251 | `indexTranscript(root: HTMLElement): TranscriptIndex`, `matchRanges(index, match: FindMatch): Range[]`, `paintHighlights(layers: Range[][], activeIndex: number): void` |
| components/ui/flyout/popover.tsx | Inline hover surface (no portal) with clamping + line budget | 368 | `Flyout`/`Popover` components |
| components/ui/session-info-dialog/session-info.ts | `SessionStats` -> display rows, NaN-safe | 166 | `modelLabel(session: SessionState \| null): string \| null`, `SessionInfoView` |
| webview/src/utils/find-query.ts | Case/regex query compile + match collection | ~110 | `compileFindQuery(query: string, options?: FindOptions): { pattern: RegExp \| null; error?: string }`, `findMatches(haystack, query, options?): FindHits` |
| webview/src/utils/prompt-chain.ts | Split one composer entry into chained `/commands` (pi expands only the leading one) | 68 | `splitPromptChain(text: string, isCommand: (name: string) => boolean): string[]` |
| webview/src/hooks/use-stick-to-bottom.ts | Follow-newest while reading nested output, hand back on scroll-up | ~102 | `useStickToBottom<T extends HTMLElement>(revision: unknown, active = true): StickToBottom<T>` |
| webview/src/stores/composer-store.ts | Imperative composer API (insert/focus/attachments) | 62 | `useComposerStore`, `type ComposerOp = (api: ComposerApi) => void` |

## Cross-References

| File | Called by / calls | Why it's central |
|---|---|---|
| webview/src/store.ts | `contexts/chat-context.tsx`; every chat component; calls `shared/blocks.ts` | Single reducer is the only writer of chat state |
| shared/blocks.ts | `store.ts`, `agent-timeline.tsx`, `session-store.ts` (host) | Keeps renderers safe against raw wire shapes |
| webview/src/apis/vscode.ts | `app-shell.tsx`, `apis/actions.ts` | Only host boundary in the bundle |
| components/exec-view/tool-display.ts | `subagent-calls/subagent-details.ts`, `tool-call-view.tsx` | Shared label/duration/preview mapping for parent + child rows |
| components/entry-view/agent-timeline.tsx | `message-list.tsx`, blocks helpers | Where a bad content shape becomes a crash if not normalized |

## Key Architectural Patterns

1. **One reducer, one producer.** `Shell` subscribes to `onHostMessage` and forwards everything as
   `dispatch({ type: 'host', message })`; `reducer`/`applyRpcEvent` in `store.ts` is the only place chat
   state changes. Chat state lives in React context (`useChatState`); **zustand is only for ephemeral UI
   stores** (composer, confirm, turn-nav, provider-login, session-info).
2. **Normalize at the boundary, then trust.** `normalizeContent` runs on every store write and history
   seed, so components may assume `ContentBlock[]` (pi sends `role:"system"` with a plain string). Filter
   with `isDisplayableRole` rather than special-casing a role in a renderer.
3. **Tools are a side table, not messages.** `tools: Record<string, ToolExec>` keyed by tool-call id,
   linked via `linkChild`/`withParentLink`. Nested (subagent) calls stay `ToolExec` children and never
   become top-level message rows — that is what keeps the timeline clean.
4. **Per-folder component pattern:** `name/` with `name.tsx` + `name.scss` + `index.ts` barrel; kebab-case
   files, PascalCase exports. Styling is `.scss` + `--amulet-*` design tokens compiled by the esbuild sass
   plugin — no inline CSS or JS-driven styling.
5. **Hover surfaces are in-flow DOM, not portals.** `Flyout` renders inline, so paint order follows the
   ancestors (`.exec-header` above `.exec-content`, `.exec-block:has(.flyout)` + `isolation: isolate`);
   surfaces are `pointer-events: none` and clipped by `tipHead`/`tipTail`. Copy — not text selection — is
   how full command/task text leaves a card.
6. **Search reads the DOM, not state:** `chat-find` indexes rendered text nodes and paints `Range`
   highlights, so it finds text inside collapsed blocks; a text-based re-scan would miss it.
7. **Dialogs must answer exactly once** — an unanswered `extension_ui_request` parks the whole run; the
   reducer also clears `pendingUi` whenever `runtimeStatus !== 'ready'`.
8. **Tests are pure-logic + capture replay:** `store.test.ts` replays real `pi 1.4.0` wire captures
   (incl. nested tool calls) through `reducer`; visual/behavioural changes still need an F5 pass.

## Read Triggers

| If you need to... | Open these files |
|---|---|
| Handle a new/changed runtime event in the UI | `webview/src/store.ts` (`applyRpcEvent`), `shared/blocks.ts`, then replay in `store.test.ts` |
| Add a message/tool render style | `components/entry-view/agent-timeline.tsx`, `exec-view/tool-call-view.tsx`, `exec-view/tool-display.ts`, matching `.scss` |
| Add a host message type | `shared/protocol.ts` (`HostMessage`), `webview/src/store.ts`, `apis/vscode.ts` consumer |
| Send something new to the host | `webview/src/apis/actions.ts`, `shared/protocol.ts` (`WebviewMessage`), host `chat-bridge.handleMessage` |
| Change composer behaviour (slash cmds, attachments, steering) | `components/input-bar/input-bar/composer.tsx`, `cmd-menu/slash-command-menu.tsx`, `stores/composer-store.ts`, `hooks/use-slash-commands.ts`, `utils/prompt-chain.ts` |
| Change the context meter | `components/input-bar/ctx-meter/context-usage.ts`, `context-stats.tsx`, host `pushStats` |
| Change approval dialogs | `components/ui/permission-prompt/` (`permission-prompt.tsx`, `ui-response.ts`), `App.tsx` mount point |
| Fix scroll/stick/viewport jitter | `hooks/use-stick-to-bottom.ts`, `components/entry-list/message-list.tsx`, `stores/turn-nav-store.ts` |
| Fix a hover/tooltip that renders under something | `components/ui/flyout/popover.tsx` + the owning card's `.scss` z-index rules |
| Add a zustand store | copy shape from `stores/confirm-store.ts` (state + imperative helper export) |

## Dependencies

### Runtime
| Package / Module | Role | Version |
|---|---|---|
| `react` / `react-dom` | Rendering, `useReducer` chat state | ^18.3.1 |
| `zustand` | Focused UI stores only | ^5.0.14 |
| `react-markdown` + `remark-gfm` + `rehype-highlight` + `highlight.js` | `md-render.tsx`, `code-block/highlighted-code.tsx` | ^9.0.1 / ^4.0.0 / ^7.0.1 / ^11.10 |
| `react-icons`, `@lobehub/icons-static-svg` | Icons, provider logos (`libs/provider-icons.ts`) | ^5.7.0 / ^1.91.0 |

### Build-time (host repo, esbuild only — `tsc` is `noEmit`)
| Package / Module | Role | Version |
|---|---|---|
| `esbuild` | IIFE browser bundle from `webview/src/main.tsx` | ^0.24.0 |
| `sass` | `.scss` → injected CSS, load paths rooted at `webview/src` | ^1.101.0 |
| `vitest` | 12 test files (138 tests) incl. wire-capture reducer replay | ^4.1.10 |
