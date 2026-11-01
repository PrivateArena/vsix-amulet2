import { useDeferredValue, useMemo } from 'react';
import { parseStreamingToolArgs } from '../../../shared/tool-args';

export interface StreamingToolArgs {
  /** Arguments recovered from the buffer, `undefined` while nothing has arrived. */
  args?: Record<string, unknown>;
  /** True while the model is still producing the call's arguments. */
  typing: boolean;
}

/**
 * The arguments of a tool call that the model is still producing, and whether it is.
 *
 * pi buffers a streamed call as raw JSON text on the content block (`partialArgs`, see
 * `applyAssistantEvent`) and only hands over a parsed object at `toolcall_end`, so a card
 * that shows work in progress has to parse the buffer itself — once per rendered frame, not
 * once per streamed token.
 *
 * `useDeferredValue` is what keeps a large `write` affordable: the parse runs in a low-
 * priority pass, so typing, scrolling and the rest of the transcript stay responsive. Both
 * fields come out of that one deferred snapshot, which is what keeps a card from ever
 * pairing a finished `typing` flag with a stale preview of the buffer — the arguments the
 * card shows and the state it claims are always the same frame of the stream.
 */
export function useStreamingToolArgs(
  partialArgs: string | undefined,
): StreamingToolArgs {
  const buffered = useDeferredValue(partialArgs);
  const args = useMemo(
    () => parseStreamingToolArgs(buffered),
    // The buffer is a fresh string per delta, so the parse is keyed by its content.
    [buffered],
  );
  return { args, typing: buffered !== undefined };
}
