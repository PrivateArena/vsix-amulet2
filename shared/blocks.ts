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
  AssistantStreamEvent,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
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
