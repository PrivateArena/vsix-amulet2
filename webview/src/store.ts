import type {
  AppMessage,
  Attachment,
  CommandInfo,
  ContentBlock,
  ExtensionUiRequest,
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
  ToolResultMessage,
} from '../../shared/protocol';
import {
  applyAssistantEvent,
  asToolCall,
  normalizeContent,
  textOfContent,
} from '../../shared/blocks';

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
   * Set when pi dropped this nested call's arguments from its record to stay under
   * the size budget — the byte count it omitted, for the row's preview.
   */
  argsOmittedBytes?: number;
  /** Ids of the calls this tool made, in arrival order. */
  childIds?: string[];
  /** False when pi truncated the nested-call record (count/size limits). */
  nestedComplete?: boolean;
}

export interface UiMessage {
  uid: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  streaming: boolean;
  usage?: AppMessage['usage'];
  model?: string;
  timestamp?: number;
  attachments?: import('../../shared/protocol').Attachment[];
}

export interface ChatState {
  status: RuntimeStatus;
  models: ModelInfo[];
  session: SessionState | null;
  messages: UiMessage[];
  tools: Record<string, ToolExec>;
  streaming: boolean;
  compacting: boolean;
  thinkingLevel: ThinkingLevel;
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
  compacting: false,
  thinkingLevel: 'medium',
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
function isDisplayableRole(role: string): boolean {
  return DISPLAYABLE_ROLES.has(role);
}

let uidCounter = 0;
function nextUid(): string {
  return `m${Date.now().toString(36)}_${uidCounter++}`;
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

function seedToolsFromHistory(
  messages: AppMessage[],
): Record<string, ToolExec> {
  const tools: Record<string, ToolExec> = {};
  for (const m of messages) {
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
      resultBlocks: normalizeContent(result.content),
      resultText: textOfContent(result.content),
    };
    // Nested calls are only recoverable from the parent's record: the child never
    // produces messages in this session. Outputs are not persisted, so a reloaded
    // card lists calls without expandable results.
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
      };
    }
    tools[id] = {
      ...tools[id],
      childIds,
      nestedComplete: nested.complete,
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
      return { ...state, status: message.status };
    case 'models':
      return { ...state, models: message.models };
    case 'config':
      return { ...state, thinkingLevel: message.config.thinkingLevel };
    case 'state':
      return {
        ...state,
        session: message.state,
        streaming: message.state.isStreaming,
        compacting: message.state.isCompacting,
        thinkingLevel: message.state.thinkingLevel,
      };
    case 'history': {
      const newMessages = message.messages
        .filter((m) => isDisplayableRole(m.role))
        .map(toUiMessage)
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
        userAttachments,
      };
    }
    case 'extensionUiRequest':
      return { ...state, pendingUi: [...state.pendingUi, message.request] };
    case 'sessions':
      return { ...state, sessions: message.sessions, hasLoadedHistory: true };
    case 'stats':
      return { ...state, stats: message.stats };
    case 'commands':
      return { ...state, commands: message.commands };
    case 'rpcEvent':
      return applyRpcEvent(state, message.event);
    // focusInput / insertText / enterForkMode / pickedFiles are handled in the
    // Shell before reaching the reducer; anything else is a no-op here.
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
      if (!msg || !isDisplayableRole(msg.role)) {
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
          return {
            ...m,
            content,
            usage: snapshot?.usage ?? e.usage ?? m.usage,
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
      return { ...state, compacting: true };
    case 'compaction_end':
      return { ...state, compacting: false };
    default:
      return state;
  }
}
