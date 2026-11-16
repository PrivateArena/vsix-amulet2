import { create } from 'zustand';
import type { WebviewConfig } from '../../../shared/protocol';

/**
 * The **Reduced motion** preference (`amulet.reducedMotion`).
 *
 * Host-owned state like Privacy mode, Line breaks and the two alert switches: the value arrives in the
 * `config` HostMessage and the webview only ever asks the host to write it, so the Settings editor,
 * another surface and this menu cannot disagree about it.
 *
 * What it does happens on the host, not here. A streamed reply reaches the chat as one `message_update`
 * per token, and each of those is a bridge message, a reducer pass over the conversation and a Markdown
 * re-parse of the paragraph that just grew — which is faithful to the stream and expensive in the same
 * proportion. With this on, the bridge folds consecutive deltas of the same content slot together and
 * forwards them on a cadence (see `src/webview/stream-pacer.ts`), so the text lands in small blocks.
 * Same events, same order, same final payload: only how often the transcript repaints moves, which is
 * why nothing here has to know about the chunking itself.
 */

interface ReducedMotionState {
  /** The bridge paces the streamed deltas instead of forwarding every token. */
  reducedMotion: boolean;
}

/** The manifest default, so the first paint is right before the host's `config` lands. */
const REDUCED_MOTION_DEFAULT = false;

export const useReducedMotionStore = create<ReducedMotionState>(() => ({
  reducedMotion: REDUCED_MOTION_DEFAULT,
}));

/** Apply the streaming half of a `config` push; ignore anything that did not change. */
export function applyReducedMotionConfig(config: WebviewConfig): void {
  if (useReducedMotionStore.getState().reducedMotion === config.reducedMotion) {
    return;
  }
  useReducedMotionStore.setState({ reducedMotion: config.reducedMotion });
}

/** Whether the stream is chunked — the menu checkmark. */
export function useReducedMotion(): boolean {
  // Subscribe so a flip repaints the menu, then read the live value: `useSyncExternalStore` answers
  // with the *initial* state while rendering on a server, so a selected value would be the shipped
  // default in a test render no matter what the setting said. `useNotifySticky` does the same.
  useReducedMotionStore((s) => s.reducedMotion);
  return useReducedMotionStore.getState().reducedMotion;
}
