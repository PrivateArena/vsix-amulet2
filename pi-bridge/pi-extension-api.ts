/**
 * The slice of pi's extension API that the Amulet bridge uses.
 *
 * This is a *declared mirror*, not a vendored copy: pi is a peer dependency that Amulet never bundles
 * (the extension is loaded by pi's own jiti loader, which passes the real objects in), and the repo
 * deliberately has no `@earendil-works/pi-coding-agent` dependency to type against. Shapes here are
 * transcribed from pi 1.5.0 — `dist/core/extensions/types.d.ts`, `dist/core/session-manager.d.ts`,
 * `dist/core/messages.d.ts` — and every field we consume is named there. When pi changes one of them,
 * the runtime smoke test (`pi -e dist/pi-bridge/amulet-bridge.js --mode rpc`, then `/amulet hello`) is
 * what catches it, not this file: keep the two in step and treat a mismatch as a bridge bug.
 *
 * Everything in this file is types, so esbuild emits nothing for it.
 */

// ---------------------------------------------------------------------------
// Messages (pi-ai `Message` + coding-agent `CustomMessage`, as the context hook sees them)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  mimeType?: string;
  data?: string;
  [key: string]: unknown;
}

/** A tool call an assistant message asked for. `id` is the `toolCallId` a result answers. */
export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolCallContent
  | { type: string; [key: string]: unknown };

export type MessageContent = string | ContentBlock[];

/**
 * One model-visible message. Declared open on purpose: the `context` hook hands us whatever role pi
 * carries today (`user`, `assistant`, `toolResult`, `custom`, `bashExecution`, …), and the bridge must
 * pass through any shape it does not recognise rather than guess.
 */
export interface AgentMessage {
  role: string;
  content: MessageContent;
  /** `toolResult` only: the `toolCall` this message answers. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolResultMessage extends AgentMessage {
  role: 'toolResult';
  toolCallId: string;
}

// ---------------------------------------------------------------------------
// Session entries (pi's append-only JSONL tree)
// ---------------------------------------------------------------------------

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: AgentMessage;
}

/** The projection rule pi applies itself: null omits the target, a value replaces only its content. */
export interface ContextEditEntry extends SessionEntryBase {
  type: 'context_edit';
  targetId: string;
  replacement: { content: MessageContent } | null;
}

/** What a `turn_end` draft may propose. Only `context_edit` is Amulet's. */
export interface ContextEditEntryDraft {
  type: 'context_edit';
  targetId: string;
  replacement: { content: MessageContent } | null;
}

/** The other draft types pi accepts at a boundary, kept opaque: the bridge forwards them untouched. */
export interface OtherBoundaryDraft {
  type: 'custom' | 'custom_message' | 'compaction';
  [key: string]: unknown;
}

export type SessionBoundaryDraft = ContextEditEntryDraft | OtherBoundaryDraft;

export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId?: string | null;
}

export type SessionEntry =
  SessionMessageEntry | ContextEditEntry | CompactionEntry | SessionEntryBase;

/**
 * The read-only view pi hands an extension. The write methods (`appendContextEdit`, `branch`, …) are
 * deliberately absent: `SessionManager` is not reachable from an extension, which is the whole reason
 * the durable edit has to ride out as a `turn_end` draft.
 */
export interface ReadonlySessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  /** Entries on the path to the current leaf, root → leaf. */
  getBranch(fromId?: string): SessionEntry[];
  /** The same path, reduced to what the model context keeps (compaction-aware, edits included). */
  buildContextEntries(): SessionEntry[];
}

// ---------------------------------------------------------------------------
// Extension surface
// ---------------------------------------------------------------------------

export interface ExtensionUIContext {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

export interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: 'tui' | 'rpc' | 'print';
  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  isIdle(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
}

export interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  /** Revert/undo: move the leaf. Same file, so Amulet's resume and cache contract is untouched. */
  navigateTree(
    targetId: string,
    options?: { summarize?: boolean; label?: string },
  ): Promise<{ cancelled: boolean }>;
}

export interface SessionStartEvent {
  type: 'session_start';
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}

export interface SessionTreeEvent {
  type: 'session_tree';
  newLeafId: string | null;
  oldLeafId: string | null;
  fromExtension?: boolean;
}

export interface ContextEvent {
  type: 'context';
  /** The conversation without the system message; pi restores its own state after the handler. */
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

export interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
  messageEntryId: string;
  toolResultEntryIds: string[];
  /** The drafts proposed so far (by pi and by earlier extensions), which a handler must extend rather than replace. */
  entries: SessionBoundaryDraft[];
  outcome: 'completed' | 'aborted' | 'error';
}

export interface TurnEndEventResult {
  entries?: SessionBoundaryDraft[];
  continue?: boolean;
}

export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => R | void | Promise<R | void>;

export interface ExtensionAPI {
  on(
    event: 'session_start',
    handler: ExtensionHandler<SessionStartEvent>,
  ): () => void;
  on(
    event: 'session_tree',
    handler: ExtensionHandler<SessionTreeEvent>,
  ): () => void;
  on(
    event: 'context',
    handler: ExtensionHandler<ContextEvent, ContextEventResult>,
  ): () => void;
  on(
    event: 'turn_end',
    handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>,
  ): () => void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ): void;
}
