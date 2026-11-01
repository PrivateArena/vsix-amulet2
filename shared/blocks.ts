/**
 * Content-block helpers shared by the extension host and the webview.
 *
 * pi content blocks are an intentionally open union (see `ContentBlock` in
 * `protocol.ts`): the runtime emits more block shapes than the UI renders. These
 * narrowing guards let call sites read the well-known fields (`text`,
 * `thinking`, tool-call `id`/`name`/`arguments`) without scattering `as any`
 * casts, while keeping the union open.
 *
 * Lives in `shared/` so it compiles for both bundle targets (host CJS + webview
 * IIFE); it imports types only.
 */
import type {
  AppMessage,
  AssistantStreamEvent,
  ContentBlock,
  ImageBlock,
  RpcEvent,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolExecutionEnd,
  ToolExecutionUpdate,
  ToolImageRef,
  ToolResultMessage,
} from './protocol';

/** Narrow a block to a text block, or null. */
export function asText(block: ContentBlock): TextBlock | null {
  return block.type === 'text' && typeof (block as TextBlock).text === 'string'
    ? (block as TextBlock)
    : null;
}

/** Narrow a block to a thinking block, or null. */
export function asThinking(block: ContentBlock): ThinkingBlock | null {
  return block.type === 'thinking' &&
    typeof (block as ThinkingBlock).thinking === 'string'
    ? (block as ThinkingBlock)
    : null;
}

/** Narrow a block to a tool-call block, or null. */
export function asToolCall(block: ContentBlock): ToolCallBlock | null {
  return block.type === 'toolCall' &&
    typeof (block as ToolCallBlock).id === 'string'
    ? (block as ToolCallBlock)
    : null;
}

/** Narrow a block to an image block, or null. */
export function asImage(block: ContentBlock): ImageBlock | null {
  return block.type === 'image' ? (block as ImageBlock) : null;
}

/** Decoded size of a base64 payload, measured without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Drop the base64 payload from image blocks, keeping everything needed to identify
 * them.
 *
 * A screenshot read is megabytes of text on a wire that UI code then keeps in memory
 * for the life of the session — and nothing in the UI needs those bytes until a reader
 * expands the card. The host runs this before forwarding an event or a history push, so
 * the payload crosses the boundary at most once, on request (`loadToolImage`).
 *
 * Non-mutating and identity-stable: an array with nothing to strip comes back as-is,
 * because the reducer's memoization depends on that.
 */
export function stripImagePayloads(
  content: ContentBlock[] | string,
): ContentBlock[] | string {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  let stripped = false;
  const next = content.map((block) => {
    const image = asImage(block);
    const data = image?.data;
    if (!image || typeof data !== 'string') return block;
    stripped = true;
    const { data: _data, ...rest } = image;
    return { ...rest, bytes: image.bytes ?? base64Bytes(data) };
  });
  return stripped ? next : content;
}

/**
 * The images a tool returned, as renderable references (no pixels attached).
 *
 * `args` is the call's arguments: the path is what a card later asks the host to read,
 * so a tool whose source is not a file yields a reference with no `path`, which the
 * card shows as a description rather than a broken image.
 */
export function toolImagesOf(
  content: unknown,
  args?: unknown,
): ToolImageRef[] | undefined {
  const images = normalizeContent(content)
    .map(asImage)
    .filter((image): image is ImageBlock => image !== null)
    .map((image) => ({
      path: imageSourceOf(args),
      mimeType: typeof image.mimeType === 'string' ? image.mimeType : 'image/*',
      bytes:
        image.bytes ??
        (typeof image.data === 'string' ? base64Bytes(image.data) : 0),
    }));
  return images.length > 0 ? images : undefined;
}

/** Argument keys a file-reading tool may name its source with. */
const IMAGE_SOURCE_KEYS = ['path', 'file_path', 'filePath', 'file'];

function imageSourceOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of IMAGE_SOURCE_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Redact the image payloads of one wire event, keeping every reference field.
 *
 * Tool results are the only images redacted here, and they travel in four shapes: the
 * `tool_execution_*` events, the settled `message_start`/`message_end` pair, and the run
 * recap that `turn_end` (its tool results) and `agent_end` (its messages) carry — those
 * two repeat, per run, what the tool events already delivered. A user message's own
 * attachment is input to the model rather than a card's output, and it stays intact.
 */
export function stripEventImages(event: RpcEvent): RpcEvent {
  const e = event as ToolExecutionEnd | ToolExecutionUpdate;
  if (e.type === 'tool_execution_end' && e.result?.content !== undefined) {
    const content = stripImagePayloads(e.result.content);
    return content === e.result.content
      ? event
      : { ...e, result: { ...e.result, content } };
  }
  if (
    e.type === 'tool_execution_update' &&
    e.partialResult?.content !== undefined
  ) {
    const content = stripImagePayloads(e.partialResult.content);
    return content === e.partialResult.content
      ? event
      : { ...e, partialResult: { ...e.partialResult, content } };
  }
  const settled = event as { message?: AppMessage };
  if (settled.message && isToolResultMessage(settled.message)) {
    const message = stripMessageImages(settled.message);
    return message === settled.message
      ? event
      : ({ ...event, message } as RpcEvent);
  }
  const run = event as { toolResults?: AppMessage[]; messages?: AppMessage[] };
  if (run.toolResults) {
    const toolResults = stripMessageImagePayloads(run.toolResults);
    if (toolResults !== run.toolResults) {
      return { ...event, toolResults } as RpcEvent;
    }
  }
  if (run.messages) {
    const messages = stripMessageImagePayloads(run.messages);
    if (messages !== run.messages) return { ...event, messages } as RpcEvent;
  }
  return event;
}

/**
 * Redact the image payloads of persisted tool results in a history snapshot, so a
 * reloaded session with a dozen screenshots does not carry their bytes into the UI.
 */
export function stripHistoryImagePayloads(
  messages: AppMessage[],
): AppMessage[] {
  return stripMessageImagePayloads(messages);
}

/** Copy-on-change over a message list: the same array is back when nothing was stripped. */
function stripMessageImagePayloads(messages: AppMessage[]): AppMessage[] {
  if (!messages.some(isToolResultMessage)) return messages;
  return messages.map((message) =>
    isToolResultMessage(message) ? stripMessageImages(message) : message,
  );
}

function isToolResultMessage(message: AppMessage): boolean {
  return (message as unknown as ToolResultMessage).role === 'toolResult';
}

function stripMessageImages(message: AppMessage): AppMessage {
  const result = message as unknown as ToolResultMessage;
  const content = stripImagePayloads(result.content);
  return content === result.content
    ? message
    : ({ ...message, content } as AppMessage);
}

/**
 * Concatenate the text of all text blocks in a message's content.
 *
 * Accepts the loosely-typed content shape the runtime produces (a string, an
 * array of blocks, or neither). `separator` defaults to `''` for reconstructing
 * streamed assistant text verbatim; pass `' '` for a readable one-line preview.
 */
export function textOfContent(content: unknown, separator = ''): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .map((block) => asText(block)?.text ?? '')
    .join(separator);
}

/**
 * Coerce a wire message body into renderable content blocks.
 *
 * pi sends `user` and `system` bodies as a plain string and `assistant` bodies
 * as a block array, and it may send neither. Everything downstream (React keys,
 * `.map`/`.forEach`, block guards) assumes an array, so crossing this boundary is
 * the one place that difference gets reconciled. An empty string yields no blocks
 * — that is the leading system message, which carries its text in `sections`.
 */
export function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks = content as ContentBlock[];
  // Return the original array when it is already well-formed, so callers that
  // keep the result (store state, memo deps) do not churn identity per render.
  let dirty = false;
  for (const block of blocks) {
    if (!isBlock(block)) {
      dirty = true;
      break;
    }
  }
  return dirty ? blocks.filter((block) => isBlock(block)) : blocks;
}

function isBlock(block: unknown): block is ContentBlock {
  return (
    !!block &&
    typeof block === 'object' &&
    typeof (block as ContentBlock).type === 'string'
  );
}

function emptyText(): TextBlock {
  return { type: 'text', text: '' };
}

/**
 * Fold one streaming delta into the assistant message's content blocks.
 *
 * `contentIndex` addresses the block slot the provider is filling, so the array
 * grows in place and keeps the order the final `message_end` will have. Deltas
 * are appended, `_end` events overwrite with the authoritative text, and an
 * unknown event leaves the array untouched (identically) so memoized renders skip.
 */
export function applyAssistantEvent(
  blocks: ContentBlock[],
  event: AssistantStreamEvent | undefined,
): ContentBlock[] {
  if (!event || typeof event.type !== 'string') return blocks;
  // `AssistantStreamEvent` stays an open union, so read the payload fields
  // through one structural view instead of narrowing every case.
  const ev = event as {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    id?: string;
    toolName?: string;
    toolCall?: ToolCallBlock;
  };
  const index =
    typeof ev.contentIndex === 'number' && ev.contentIndex >= 0
      ? ev.contentIndex
      : 0;

  const next = blocks.slice();
  while (next.length <= index) next.push(emptyText());
  const current = next[index];

  switch (ev.type) {
    case 'text_start':
      if (!asText(current)) next[index] = emptyText();
      return next;
    case 'text_delta': {
      const text = asText(current)?.text ?? '';
      next[index] = { type: 'text', text: text + (ev.delta ?? '') };
      return next;
    }
    case 'text_end': {
      const existing = asText(current);
      next[index] = {
        type: 'text',
        ...(existing?.textSignature
          ? { textSignature: existing.textSignature }
          : {}),
        text:
          typeof ev.content === 'string' ? ev.content : (existing?.text ?? ''),
      };
      return next;
    }
    case 'thinking_start':
      if (!asThinking(current))
        next[index] = { type: 'thinking', thinking: '' };
      return next;
    case 'thinking_delta': {
      const thinking = asThinking(current)?.thinking ?? '';
      next[index] = {
        type: 'thinking',
        thinking: thinking + (ev.delta ?? ''),
      };
      return next;
    }
    case 'thinking_end': {
      const existing = asThinking(current);
      next[index] = {
        type: 'thinking',
        ...(existing?.thinkingSignature
          ? { thinkingSignature: existing.thinkingSignature }
          : {}),
        thinking:
          typeof ev.content === 'string'
            ? ev.content
            : (existing?.thinking ?? ''),
      };
      return next;
    }
    case 'toolcall_start': {
      const existing = asToolCall(current);
      next[index] = {
        type: 'toolCall',
        id: ev.id ?? existing?.id ?? '',
        name: ev.toolName ?? existing?.name ?? 'tool',
        arguments: existing?.arguments,
        partialArgs: existing?.partialArgs ?? '',
      };
      return next;
    }
    case 'toolcall_delta': {
      const existing = asToolCall(current) ?? {
        type: 'toolCall' as const,
        id: '',
        name: 'tool',
      };
      next[index] = {
        ...existing,
        partialArgs: (existing.partialArgs ?? '') + (ev.delta ?? ''),
      };
      return next;
    }
    case 'toolcall_end': {
      const call = ev.toolCall;
      if (!call || typeof call.type !== 'string') return blocks;
      // The finished call is authoritative — drop the streaming arg buffer.
      const { partialArgs: _partialArgs, ...rest } = { ...call };
      next[index] = rest;
      return next;
    }
    default:
      // `start`, `done`, `error` and any newer runtime event: `message_end` and
      // the retry UI own those, the block list does not change here.
      return blocks;
  }
}
