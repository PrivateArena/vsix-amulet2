import { create } from 'zustand';

/**
 * The slice of the transcript the floating composer has to keep clear.
 *
 * `.chat-input-wrap` is absolutely positioned over `#chat-log`, so the log reserves the
 * bottom of its scroll area for it: without that, the last reply would end under the
 * composer, unreachable behind it. The reservation therefore has to follow the textarea
 * as the draft grows — which is why the number is written straight onto the log element.
 *
 * Two rules this exists to keep:
 *
 * - **Never an inherited custom property on `<html>`.** Changing an inherited custom
 *   property makes Blink recompute the style of *every* descendant, so one composer
 *   height change cost the whole transcript — the composer got slower to type in for
 *   every message already on screen. A non-inherited property on the one consumer
 *   element dirties that element alone.
 * - **Never through React state.** The log re-renders every turn it holds; a height
 *   number in a store would put the transcript on the composer's keystroke path.
 */

/** Gap between the composer's top edge and the last transcript row. */
const TAIL_GAP_PX = 4;

interface ComposerReserveStore {
  /** The transcript scroller, or `null` while no transcript is mounted. */
  log: HTMLElement | null;
  /** Publish the log element for the composer; returns the unregistering handle. */
  registerLog: (log: HTMLElement | null) => () => void;
}

export const useComposerReserveStore = create<ComposerReserveStore>(
  (set, get) => ({
    log: null,
    registerLog: (log) => {
      set({ log });
      return () => {
        if (get().log === log) set({ log: null });
      };
    },
  }),
);

/** Reserve `heightPx` of scroll padding for the composer (its measured outer height). */
export function reserveForComposer(heightPx: number): void {
  const log = useComposerReserveStore.getState().log;
  if (!log) return;
  const next = `${Math.max(0, Math.round(heightPx)) + TAIL_GAP_PX}px`;
  // Writing the same value would still dirty the element's style, and the observer
  // that measures the composer fires for sub-pixel growth too.
  if (log.style.paddingBottom !== next) log.style.paddingBottom = next;
}

/** Hand the log its own bottom padding back (composer unmounted). */
export function clearComposerReserve(): void {
  const log = useComposerReserveStore.getState().log;
  if (log) log.style.paddingBottom = '';
}
