import type {
  AppMessage,
  AssistantStreamEvent,
  Attachment,
  CommandInfo,
  CompactionEndEvent,
  CompactionReason,
  CompactionStartEvent,
  ContentBlock,
  ExtensionUiRequest,
  HistoryMessage,
  HostMessage,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelInfo,
  RpcEvent,
  RuntimeStatus,
  SessionInfo,
  SessionState,
  SessionStats,
  ThinkingLevel,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolExecutionUpdate,
  ToolImageRef,
  ToolResultMessage,
  Usage,
} from '../../shared/protocol';
import {
  applyAssistantEvent,
  asToolCall,
  normalizeContent,
  textOfContent,
  toolImagesOf,
} from '../../shared/blocks';
import { FALLBACK_THINKING_LEVELS } from '../../shared/protocol';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolExec {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: ToolStatus;
  resultText?: string;
  resultBlocks?: ContentBlock[];
  isError?: boolean;
  /**
   * Id of the tool call that made this one (`ctx.executeTool()`). Nested calls get
   * no message of their own, so they hang off the parent instead of the timeline.
   */
  parentToolCallId?: string;
  /** Wall-clock duration, from `tool_execution_end`. */
  durationMs?: number;
  /**
   * Epoch ms of `tool_execution_start`, so a running card can count up live. A
   * reloaded history has `durationMs` and no start time, hence both exist.
   */
  startedAt?: number;
  /** The tool's own `details` payload (subagent progress card, report, …). */
  details?: unknown;
  /**
   * Images the tool returned, as references only: their bytes stay on disk until a
   * reader expands the card (see `loadToolImage`). Undefined for the overwhelming
   * majority of calls.
   */
  images?: ToolImageRef[];
  /**
   * Set when pi dropped this nested call's arguments from its record to stay under
   * the size budget — the byte count it omitted, for the row's preview.
   */
  argsOmittedBytes?: number;
  /** Ids of the calls this tool made, in arrival order. */
  childIds?: string[];
  /** False when pi truncated the nested-call record (count/size limits). */
  nestedComplete?: boolean;
  /**
   * True when this tool's nested list was rebuilt from pi's persisted `nestedCalls`
   * record rather than from live events. The record carries arguments and error text
   * only — never a successful output — so those rows have nothing to expand to.
   */
  nestedFromRecord?: boolean;
}

/**
 * A compaction the runtime is running right now, as far as the wire lets us know it:
 * pi emits `compaction_start`, then nothing at all until `compaction_end` — the summary
 * itself is generated on a detached provider call whose deltas never reach an rpc client.
 * So the live card has a clock and the retry events, and no progress percentage.
 */
export interface CompactionRun {
  /** Null when the source is `get_state.isCompacting`, which reports no reason. */
  reason: CompactionReason | null;
  /** Arrival clock of `compaction_start` — the event carries no timestamp. */
  startedAt: number;
  /** Set while the summariser waits out a provider-error backoff. */
  retry?: { attempt?: number; maxAttempts?: number; errorMessage?: string };
}

/**
 * The settled outcome of one compaction, rendered as a transcript card. Built from
 * `compaction_end` while the session lives, and from pi's persisted `compactionSummary`
 * message on reload — which is why all but `outcome`, `summary` and `tokensBefore` are optional.
 */
export interface CompactionInfo {
  outcome: 'done' | 'aborted' | 'failed';
  reason: CompactionReason | null;
  /** Absent for a card rebuilt from history, and for an end event with no matching start. */
  startedAt?: number;
  endedAt: number;
  durationMs?: number;
  summary?: string;
  tokensBefore?: number;
  /** pi's own heuristic estimate of the rebuilt context, never a provider count. */
  tokensAfter?: number;
  usage?: Usage;
  readFiles?: string[];
  modifiedFiles?: string[];
  /** Why the summary failed; absent when the human cancelled it. */
  error?: string;
  /** The runtime is retrying the turn on the freshly compacted context. */
  willRetry?: boolean;
}

export interface UiMessage {
  uid: string;
  /**
   * `compaction` is the transcript's context-window boundary: no content, and it is
   * rendered on its own rather than inside a turn timeline.
   */
  role: 'user' | 'assistant' | 'system' | 'compaction';
  content: ContentBlock[];
  streaming: boolean;
  usage?: AppMessage['usage'];
  model?: string;
  timestamp?: number;
  /**
   * Epoch ms at which this assistant message's `message_start` arrived, and at which
   * its first output delta did. The wire stamps neither, so both are arrival clocks —
   * their difference is the time-to-first-token the prefill rate is derived from
   * (`progress-bar/token-rate.ts`).
   */
  startedAt?: number;
  firstTokenAt?: number;
  attachments?: import('../../shared/protocol').Attachment[];
  /** Set for `role === 'compaction'`: what one compaction cost and produced. */
  compaction?: CompactionInfo;
}

export interface ChatState {
  status: RuntimeStatus;
  models: ModelInfo[];
  session: SessionState | null;
  messages: UiMessage[];
  tools: Record<string, ToolExec>;
  streaming: boolean;
  /** The compaction the runtime is running right now, or null. */
  compaction: CompactionRun | null;
  thinkingLevel: ThinkingLevel | null;
  /** Levels the runtime offers for the current model (pi is the source of truth). */
  thinkingLevels: ThinkingLevel[];
  /** Host preference: render reasoning blocks expanded by default. */
  expandThinking: boolean;
  pendingUi: ExtensionUiRequest[];
  sessions: SessionInfo[];
  hasLoadedHistory: boolean;
  stats: SessionStats | null;
  commands: CommandInfo[];
  currentUid: string | null;
  seq: number;
  /** Local attachments for user messages (not stored by pi). Maps message uid -> attachments. */
  userAttachments: Map<string, Attachment[]>;
  /** Pending attachments waiting to be associated with the next user message. */
  pendingAttachments: Attachment[];
}

export const initialState: ChatState = {
  status: { phase: 'starting' },
  models: [],
  session: null,
  messages: [],
  tools: {},
  streaming: false,
  compaction: null,
  thinkingLevel: null,
  thinkingLevels: [...FALLBACK_THINKING_LEVELS],
  expandThinking: false,
  pendingUi: [],
  sessions: [],
  hasLoadedHistory: false,
  stats: null,
  commands: [],
  currentUid: null,
  seq: 0,
  userAttachments: new Map(),
  pendingAttachments: [],
};

const DISPLAYABLE_ROLES = new Set(['user', 'assistant', 'system']);
/** pi's persisted compaction boundary, which the transcript renders as its own card. */
const COMPACTION_ROLE = 'compactionSummary';

/** History roles the transcript renders: chat bubbles, plus pi's persisted context boundary. */
function isDisplayableHistoryRole(role: string): boolean {
  return DISPLAYABLE_ROLES.has(role) || role === COMPACTION_ROLE;
}

let uidCounter = 0;

/**
 * Does this delta carry model output? Block boundaries and lifecycle events do not,
 * so only these three can mark a message's first token.
 */
function isOutputDelta(event: AssistantStreamEvent | undefined): boolean {
  const type = event?.type;
  return (
    type === 'text_delta' ||
    type === 'thinking_delta' ||
    type === 'toolcall_delta'
  );
}

function nextUid(): string {
  return `m${Date.now().toString(36)}_${uidCounter++}`;
}

/** A count from pi's deliberately loose event payloads, or the fallback. */
function numberOr(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toUiMessage(m: AppMessage): UiMessage {
  return {
    uid: nextUid(),
    role: m.role,
    content: normalizeContent(m.content),
    streaming: false,
    usage: m.usage,
    model: m.model,
    timestamp: m.timestamp,
    attachments: m.attachments,
  };
}

/**
 * One history line → a transcript entry. pi persists a compaction as a
 * `role: "compactionSummary"` message carrying no content, so it becomes the durable
 * boundary card instead of a bubble; everything else is an ordinary message.
 */
function toUiHistoryMessage(m: HistoryMessage): UiMessage {
  if (m.role !== COMPACTION_ROLE) return toUiMessage(m);
  return {
    uid: nextUid(),
    role: 'compaction',
    content: [],
    streaming: false,
    timestamp: m.timestamp,
    compaction: {
      outcome: 'done',
      // The persisted entry records no reason, and the live run is long gone.
      reason: null,
      endedAt: m.timestamp ?? Date.now(),
      summary: m.summary,
      tokensBefore: m.tokensBefore,
    },
  };
}

function seedToolsFromHistory(
  messages: HistoryMessage[],
): Record<string, ToolExec> {
  const tools: Record<string, ToolExec> = {};
  for (const m of messages) {
    // A compaction boundary carries no content, so it can hold no tool call either.
    if (!('content' in m)) continue;
    for (const block of normalizeContent(m.content)) {
      const call = asToolCall(block);
      if (call)
        tools[call.id] = {
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
          status: 'running',
        };
    }
  }
  const settled = (
    messages as unknown as (AppMessage | ToolResultMessage)[]
  ).filter(
    (m): m is ToolResultMessage =>
      (m as { role?: string }).role === 'toolResult' &&
      typeof (m as ToolResultMessage).toolCallId === 'string',
  );
  for (const result of settled) {
    const id = result.toolCallId;
    tools[id] = {
      toolCallId: id,
      toolName: result.toolName ?? tools[id]?.toolName ?? 'tool',
      args: tools[id]?.args,
      status: result.isError ? 'error' : 'done',
      isError: !!result.isError,
      durationMs: result.durationMs,
      details: result.details,
      images: toolImagesOf(result.content, tools[id]?.args),
      resultBlocks: normalizeContent(result.content),
      resultText: textOfContent(result.content),
    };
    // Nested calls are only recoverable from the parent's record: the child never
    // produces messages in this session. The record holds no outputs, so a reloaded row
    // expands only when it failed — pi does persist the error text of a nested call.
    const nested = result.nestedCalls;
    if (!nested?.calls?.length) continue;
    const childIds: string[] = [];
    for (const call of nested.calls) {
      if (!call?.id || tools[call.id]) continue;
      childIds.push(call.id);
      tools[call.id] = {
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
        argsOmittedBytes: call.argumentsBytes,
        parentToolCallId: id,
        status:
          call.status === 'ok'
            ? 'done'
            : call.status === 'error'
              ? 'error'
              : 'running',
        isError: call.status === 'error',
        durationMs: call.durationMs,
        // A failed call is the one nested result pi does persist (500 chars), so the
        // row is expandable and its tooltip has something to show.
        resultText: call.error,
      };
    }
    tools[id] = {
      ...tools[id],
      childIds,
      nestedComplete: nested.complete,
      nestedFromRecord: true,
    };
  }
  return tools;
}

/**
 * Link a nested call to the tool that made it, keeping arrival order. Returns the
 * same map when there is nothing to do, so unrelated tool cards keep their identity.
 */
function linkChild(
  tools: Record<string, ToolExec>,
  parentId: string,
  childId: string,
): Record<string, ToolExec> {
  const parent = tools[parentId];
  if (!parent || parent.childIds?.includes(childId)) return tools;
  return {
    ...tools,
    [parentId]: { ...parent, childIds: [...(parent.childIds ?? []), childId] },
  };
}

function withParentLink(
  tools: Record<string, ToolExec>,
  entry: ToolExec,
): Record<string, ToolExec> {
  return entry.parentToolCallId
    ? linkChild(tools, entry.parentToolCallId, entry.toolCallId)
    : tools;
}

/**
 * Resolve one `compaction_end` into the transcript card it leaves behind.
 *
 * `run` is the live counter this card replaces; it is missing when the surface opened on a
 * compaction already in flight (or when pi ends one it never announced — the exhausted
 * overflow-retry budget does exactly that), and then the card has no duration to report.
 */
function compactionInfoOf(
  end: CompactionEndEvent,
  run: CompactionRun | null,
): CompactionInfo {
  const result = end.result;
  const endedAt = Date.now();
  return {
    outcome: result ? 'done' : end.aborted ? 'aborted' : 'failed',
    reason: end.reason ?? run?.reason ?? null,
    startedAt: run?.startedAt,
    endedAt,
    durationMs: run == null ? undefined : Math.max(0, endedAt - run.startedAt),
    summary: result?.summary,
    tokensBefore: result?.tokensBefore,
    tokensAfter: result?.estimatedTokensAfter,
    usage: result?.usage,
    readFiles: result?.details?.readFiles,
    modifiedFiles: result?.details?.modifiedFiles,
    error: end.errorMessage,
    willRetry: end.willRetry,
  };
}

/**
 * What the webview keeps decoded, at most: the images a reader looked at recently, not a
 * whole session's worth. A reference dropped here re-reads on its next expansion — which
 * is why the tiles ask from state rather than from a flag of their own.
 */
const MAX_RETAINED_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_RETAINED_IMAGES = 8;

/**
 * Carry a card's delivered pixels (or its failure) across the refs a later event reports
 * for the same call. pi reports a result more than once, and the end event rebuilding the
 * list would otherwise blank a tile that had already loaded.
 */
function mergeToolImages(
  next: ToolImageRef[] | undefined,
  previous: ToolImageRef[] | undefined,
): ToolImageRef[] | undefined {
  if (!next) return previous;
  if (!previous) return next;
  return next.map((image, index) => {
    const was = previous[index];
    if (!was || was.path !== image.path) return image;
    if (!was.dataUrl && !was.error) return image;
    return {
      ...image,
      dataUrl: was.dataUrl,
      size: was.size,
      error: was.error,
      loadedAt: was.loadedAt,
    };
  });
}

/**
 * Drop the oldest delivered pixels until the session is back inside the retention budget.
 */
function retainNewestImages(
  tools: Record<string, ToolExec>,
): Record<string, ToolExec> {
  type Loaded = { toolId: string; index: number; bytes: number; at: number };
  const loaded: Loaded[] = [];
  for (const [toolId, tool] of Object.entries(tools)) {
    tool.images?.forEach((image, index) => {
      if (image.dataUrl) {
        loaded.push({
          toolId,
          index,
          bytes: image.dataUrl.length,
          at: image.loadedAt ?? 0,
        });
      }
    });
  }
  let total = loaded.reduce((bytes, entry) => bytes + entry.bytes, 0);
  if (
    loaded.length <= MAX_RETAINED_IMAGES &&
    total <= MAX_RETAINED_IMAGE_BYTES
  ) {
    return tools;
  }
  // Oldest first; the image that just arrived is the newest, so it is never the victim.
  loaded.sort((a, b) => a.at - b.at);
  const victims = new Map<string, number[]>();
  let dropped = 0;
  for (const entry of loaded) {
    if (
      loaded.length - dropped <= MAX_RETAINED_IMAGES &&
      total <= MAX_RETAINED_IMAGE_BYTES
    ) {
      break;
    }
    total -= entry.bytes;
    dropped += 1;
    const list = victims.get(entry.toolId);
    if (list) list.push(entry.index);
    else victims.set(entry.toolId, [entry.index]);
  }
  if (!victims.size) return tools;
  const next = { ...tools };
  for (const [toolId, indexes] of victims) {
    const tool = next[toolId];
    const images = (tool.images ?? []).slice();
    for (const index of indexes) {
      const image = images[index];
      if (!image) continue;
      images[index] = {
        ...image,
        dataUrl: undefined,
        loadedAt: undefined,
      };
    }
    next[toolId] = { ...tool, images };
  }
  return next;
}

/**
 * Attach the pixels the host read to the reference a card asked for.
 *
 * Returns the state untouched when nothing matches: the answer can land after the session
 * that asked for it was replaced, and a card that never asked must not gain one.
 */
function applyToolImageResult(
  state: ChatState,
  message: Extract<HostMessage, { type: 'toolImage' }>,
): ChatState {
  const tool = state.tools[message.toolCallId];
  const images = tool?.images;
  if (!tool || !images?.length) return state;
  const image = images[message.index];
  // Keyed by position, because a result may hold two images of the same file; the path
  // still has to agree, or the answer belongs to a call that has moved on.
  if (!image || image.path !== message.path) return state;
  const dataUrl = message.dataUrl ?? image.dataUrl;
  const error = message.error ?? image.error;
  if (dataUrl === image.dataUrl && error === image.error) return state;
  const next = images.slice();
  next[message.index] = {
    ...image,
    dataUrl,
    error,
    // The host read the file itself, so its type beats what the runtime reported for a
    // payload that is no longer on the wire.
    mimeType: message.mimeType ?? image.mimeType,
    size: message.size ?? image.size,
    loadedAt: dataUrl ? Date.now() : image.loadedAt,
  };
  return {
    ...state,
    tools: retainNewestImages({
      ...state.tools,
      [message.toolCallId]: { ...tool, images: next },
    }),
  };
}

export type Action =
  | { type: 'host'; message: HostMessage }
  | { type: 'dismissUi'; id: string }
  | { type: 'setPendingAttachments'; attachments: Attachment[] }
  | { type: 'addPendingAttachments'; attachments: Attachment[] }
  | { type: 'clearPendingAttachments' };

export function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === 'dismissUi') {
    return {
      ...state,
      pendingUi: state.pendingUi.filter((u) => u.id !== action.id),
    };
  }
  if (action.type === 'setPendingAttachments') {
    return { ...state, pendingAttachments: action.attachments };
  }
  if (action.type === 'addPendingAttachments') {
    return {
      ...state,
      pendingAttachments: [...state.pendingAttachments, ...action.attachments],
    };
  }
  if (action.type === 'clearPendingAttachments') {
    return { ...state, pendingAttachments: [] };
  }
  const message = action.message;
  switch (message.type) {
    case 'runtimeStatus':
      return {
        ...state,
        status: message.status,
        // A dialog can only be answered by the child process that asked. Once the runtime is gone
        // (crash, restart, error) its pending questions are dead — keeping them up would leave a modal
        // overlay the human can answer forever without anything on the other end.
        pendingUi: message.status.phase === 'ready' ? state.pendingUi : [],
      };
    case 'models':
      return { ...state, models: message.models };
    case 'config':
      return {
        ...state,
        expandThinking: message.config.expandThinking,
      };
    case 'thinkingLevels':
      return { ...state, thinkingLevels: message.levels };
    case 'state':
      return {
        ...state,
        session: message.state,
        streaming: message.state.isStreaming,
        // `isCompacting` also covers a branch summary and reports no reason; keep a live run
        // (with its start time) when the two sources describe the same thing.
        compaction: message.state.isCompacting
          ? (state.compaction ?? { reason: null, startedAt: Date.now() })
          : null,
        // `undefined` means nothing has been applied to the session: the runtime is
        // running on the model/pi default, which the picker shows as "Disabled".
        thinkingLevel: message.state.thinkingLevel ?? null,
      };
    case 'history': {
      const newMessages = message.messages
        .filter((m) => isDisplayableHistoryRole(m.role))
        .map(toUiHistoryMessage)
        // Same rule as `message_start`: pi persists the leading system message
        // with its body in `sections`, so it carries no displayable blocks.
        .filter((m) => !(m.role === 'system' && m.content.length === 0));

      // Rebuild the uid->attachments map from this history: uids are freshly
      // minted on every load, so any prior mapping is stale. Only messages that
      // carry their own attachments (e.g. a persisted session) repopulate it.
      const userAttachments = new Map<string, Attachment[]>();
      for (const msg of newMessages) {
        if (msg.role === 'user' && msg.attachments?.length) {
          userAttachments.set(msg.uid, msg.attachments);
        }
      }

      return {
        ...state,
        messages: newMessages,
        tools: seedToolsFromHistory(message.messages),
        currentUid: null,
        streaming: false,
        // A snapshot is a different session (or a restarted runtime): a run this surface
        // was showing is not coming back.
        compaction: null,
        userAttachments,
      };
    }
    case 'extensionUiRequest':
      return { ...state, pendingUi: [...state.pendingUi, message.request] };
    case 'extensionUiDismiss':
      // Answered elsewhere (another panel, or VS Code's native dialog): drop this copy without answering.
      return {
        ...state,
        pendingUi: state.pendingUi.filter((u) => u.id !== message.id),
      };
    case 'sessions':
      return { ...state, sessions: message.sessions, hasLoadedHistory: true };
    case 'stats':
      return { ...state, stats: message.stats };
    case 'commands':
      return { ...state, commands: message.commands };
    case 'toolImage':
      return applyToolImageResult(state, message);
    case 'rpcEvent':
      return applyRpcEvent(state, message.event);
    // focusInput / insertText / enterForkMode / pickedFiles / projectFiles are handled in
    // the Shell before reaching the reducer; anything else is a no-op here.
    default:
      return state;
  }
}

function applyRpcEvent(state: ChatState, event: RpcEvent): ChatState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, streaming: true };
    case 'agent_end':
      return {
        ...state,
        streaming: false,
        currentUid: null,
        seq: state.seq + 1,
      };
    case 'message_start': {
      // RpcEvent ends in an open `{ type: string }` member, so `case` doesn't
      // narrow — cast to the specific event to get its optional `message` back.
      const msg = (event as MessageStartEvent).message;
      if (!msg || !DISPLAYABLE_ROLES.has(msg.role)) {
        // Deliberately the narrow role set, not `isDisplayableHistoryRole`: only history carries
        // a compaction boundary, and a streamed one must not become an empty chat bubble.
        // A settled tool result carries pi's authoritative record of the calls that
        // tool made and whether pi truncated it (count/size limits). The live list
        // is already complete for the UI, so only the flag is harvested here.
        const result = msg as unknown as ToolResultMessage | undefined;
        const nested = result?.nestedCalls;
        const parent =
          nested && result ? state.tools[result.toolCallId] : undefined;
        if (!nested || !parent || parent.nestedComplete === nested.complete) {
          return { ...state, currentUid: null };
        }
        return {
          ...state,
          currentUid: null,
          tools: {
            ...state.tools,
            [result!.toolCallId]: {
              ...parent,
              nestedComplete: nested.complete,
            },
          },
        };
      }
      const ui = toUiMessage(msg);
      ui.streaming = msg.role === 'assistant';
      if (ui.role === 'assistant') ui.startedAt = Date.now();
      if (ui.timestamp == null) ui.timestamp = Date.now();

      // pi emits a `message_start`/`message_end` pair for the leading system
      // message on every run; its body lives in `sections`, so it normalizes to
      // zero blocks. Rendering it would only add an empty turn to the timeline.
      if (ui.role === 'system' && ui.content.length === 0) return state;

      // For user messages, attach any pending attachments
      if (msg.role === 'user' && state.pendingAttachments.length > 0) {
        const newMap = new Map(state.userAttachments);
        newMap.set(ui.uid, state.pendingAttachments);
        return {
          ...state,
          messages: [...state.messages, ui],
          currentUid: ui.uid,
          userAttachments: newMap,
          pendingAttachments: [],
        };
      }

      return {
        ...state,
        messages: [...state.messages, ui],
        currentUid: ui.uid,
      };
    }
    case 'message_update': {
      // pi 1.x removed the cumulative `message` snapshot from this event: deltas
      // arrive as `assistantMessageEvent` and the client builds the blocks. Older
      // runtimes sent the whole partial message instead, which still works here.
      const e = event as MessageUpdateEvent;
      const snapshot = e.message;
      if (!state.currentUid) return state;
      if (!snapshot && !e.assistantMessageEvent) return state;
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.uid !== state.currentUid) return m;
          const content = snapshot
            ? normalizeContent(snapshot.content)
            : applyAssistantEvent(m.content, e.assistantMessageEvent);
          const hasOutput =
            m.role === 'assistant' &&
            (snapshot
              ? content.length > 0
              : isOutputDelta(e.assistantMessageEvent));
          return {
            ...m,
            content,
            usage: snapshot?.usage ?? e.usage ?? m.usage,
            // Stamped once: the first output delta of the message fixes its time-to-first-token.
            ...(m.firstTokenAt == null && hasOutput
              ? { firstTokenAt: Date.now() }
              : {}),
          };
        }),
      };
    }
    case 'message_end': {
      const msg = (event as MessageEndEvent).message;
      if (!state.currentUid) return state;
      // A missing payload still has to end the turn — otherwise the message
      // keeps its blinking caret and `streaming: true` forever.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.uid === state.currentUid
            ? {
                ...m,
                content: msg ? normalizeContent(msg.content) : m.content,
                usage: msg?.usage ?? m.usage,
                model: msg?.model ?? m.model,
                streaming: false,
              }
            : m,
        ),
        currentUid: null,
      };
    }
    case 'tool_execution_start': {
      const e = event as ToolExecutionStart;
      const entry: ToolExec = {
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: e.args,
        status: 'running',
        startedAt: Date.now(),
        parentToolCallId: e.parentToolCallId,
      };
      return {
        ...state,
        tools: withParentLink({ ...state.tools, [e.toolCallId]: entry }, entry),
      };
    }
    case 'tool_execution_update': {
      const e = event as ToolExecutionUpdate;
      const existing = state.tools[e.toolCallId];
      const entry: ToolExec = {
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: e.args ?? existing?.args,
        status: 'running',
        // A card that missed `tool_execution_start` (a panel reloaded mid-run, a host
        // re-attach) starts counting from the first event it did see.
        startedAt: existing?.startedAt ?? Date.now(),
        parentToolCallId: e.parentToolCallId ?? existing?.parentToolCallId,
        details: e.partialResult?.details ?? existing?.details,
        // A progress heartbeat rebuilds the entry, so anything this card already learned
        // about the call's images — including delivered pixels — has to be carried across.
        images: mergeToolImages(
          toolImagesOf(e.partialResult?.content, e.args ?? existing?.args),
          existing?.images,
        ),
        // A progress heartbeat rebuilds the entry, so the list of calls this tool
        // made — and pi's truncation flag — have to be carried across explicitly.
        childIds: existing?.childIds,
        nestedComplete: existing?.nestedComplete,
        resultBlocks:
          e.partialResult?.content !== undefined
            ? normalizeContent(e.partialResult.content)
            : existing?.resultBlocks,
        resultText:
          textOfContent(e.partialResult?.content) || existing?.resultText,
      };
      return {
        ...state,
        tools: withParentLink({ ...state.tools, [e.toolCallId]: entry }, entry),
      };
    }
    case 'tool_execution_end': {
      const e = event as ToolExecutionEnd;
      const existing = state.tools[e.toolCallId];
      // The result is authoritative: whatever images it does not report are gone. What it
      // repeats keeps the pixels a card already read.
      const resultImages = toolImagesOf(e.result?.content, existing?.args);
      const entry: ToolExec = {
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        args: existing?.args,
        status: e.isError ? 'error' : 'done',
        isError: e.isError,
        // pi omits `durationMs` for a call it never ran, and an aborted call has not
        // always reported one; the measured span of the live counter is the fallback.
        durationMs:
          e.durationMs ??
          existing?.durationMs ??
          (existing?.startedAt == null
            ? undefined
            : Math.max(0, Date.now() - existing.startedAt)),
        parentToolCallId: e.parentToolCallId ?? existing?.parentToolCallId,
        details: e.result?.details ?? existing?.details,
        images: resultImages
          ? mergeToolImages(resultImages, existing?.images)
          : undefined,
        // The live list is already complete for the UI; keep it across the end event.
        childIds: existing?.childIds,
        nestedComplete: existing?.nestedComplete,
        resultBlocks:
          e.result && e.result.content !== undefined
            ? normalizeContent(e.result.content)
            : existing?.resultBlocks,
        resultText: textOfContent(e.result?.content),
      };
      return {
        ...state,
        tools: withParentLink({ ...state.tools, [e.toolCallId]: entry }, entry),
      };
    }
    case 'compaction_start':
      // The only reliable signal that a compaction is running: pi answers `compact` after the
      // summarisation call, so nothing here is awaited — and this also fires for the
      // runtime's own threshold/overflow compaction, which no host command ever sees.
      return {
        ...state,
        compaction: {
          reason: (event as CompactionStartEvent).reason ?? null,
          startedAt: Date.now(),
        },
      };
    case 'compaction_end': {
      const info = compactionInfoOf(
        event as CompactionEndEvent,
        state.compaction,
      );
      return {
        ...state,
        compaction: null,
        // The boundary belongs in the transcript it just shortened — and on reload the same
        // card comes out of pi's persisted `compactionSummary` history entry.
        messages: [
          ...state.messages,
          {
            uid: nextUid(),
            role: 'compaction',
            content: [],
            streaming: false,
            timestamp: info.endedAt,
            compaction: info,
          },
        ],
      };
    }
    case 'summarization_retry_scheduled':
      if (!state.compaction) return state;
      return {
        ...state,
        compaction: {
          ...state.compaction,
          retry: {
            attempt: numberOr(event.attempt),
            maxAttempts: numberOr(event.maxAttempts),
            errorMessage:
              typeof event.errorMessage === 'string'
                ? event.errorMessage
                : undefined,
          },
        },
      };
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
      if (!state.compaction?.retry) return state;
      return {
        ...state,
        compaction: {
          ...state.compaction,
          retry: undefined,
        },
      };
    case 'thinking_level_changed': {
      // Authoritative from the runtime: also covers `cycle_thinking_level` and
      // extension-driven changes, which never round-trip through a host command.
      // `RpcEvent` is deliberately open, so the level arrives as `unknown`; accept
      // any string so a newer pi's levels still surface (labels fall back to raw).
      if (typeof event.level !== 'string') return state;
      const level = event.level as ThinkingLevel;
      return {
        ...state,
        thinkingLevel: level,
        session: state.session
          ? { ...state.session, thinkingLevel: level }
          : null,
      };
    }
    default:
      return state;
  }
}
