import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
  type UIEventHandler,
} from 'react';

/** Under this many pixels from the bottom, a scroll counts as "at the bottom". */
const BOTTOM_SLOP_PX = 24;

/**
 * Whether a scroll position counts as sitting at the bottom of a scrollable element.
 *
 * The slop absorbs sub-pixel client rects and a row that grew by less than a line, so
 * following does not disengage on its own bookkeeping.
 */
export function isScrollAtBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  slop = BOTTOM_SLOP_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < slop;
}

export interface StickToBottom<T extends HTMLElement> {
  /** Attach to the scrolling element. */
  ref: RefObject<T>;
  /** Wire to the element's `onScroll`; it decides whether following is still wanted. */
  onScroll: UIEventHandler<T>;
}

/**
 * Keep a scrollable list pinned to its newest row.
 *
 * The list follows the content while the reader is already at the bottom, and stops
 * the moment they scroll up, so a streamed list never yanks the view away from
 * something being read. Scrolling back to the bottom re-engages it.
 *
 * `revision` is the caller's count of what the list holds — bumping it is what "new
 * content arrived" means here, and it keeps this effect from running on the renders
 * (clock ticks, unrelated store updates) that add no row.
 *
 * `active` confines the behaviour to a live stream: a settled list opened later should
 * start at the top, not at whatever the last row happened to be.
 */
export function useStickToBottom<T extends HTMLElement>(
  revision: unknown,
  active = true,
): StickToBottom<T> {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  /** True from a programmatic jump until the `scroll` event it queued is delivered. */
  const synthetic = useRef(false);
  const wasActive = useRef(false);

  // Layout, not passive effect: measure then write, so the new row is never painted in
  // the position the follow is about to scroll away from.
  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false;
      return;
    }
    // A list that just became live is worth following from wherever it was left.
    if (!wasActive.current) {
      wasActive.current = true;
      stuck.current = true;
    }
    const el = ref.current;
    if (!el || !stuck.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Assigning `scrollTop` unconditionally invalidates layout on a list already at
    // the bottom, which is the state this effect is normally keeping it in.
    if (distance <= 1) return;
    // Anything the browser reports as a scroll from here on is our own doing, for as
    // long as this jump stays the most recent scroll activity.
    synthetic.current = true;
    el.scrollTop = el.scrollHeight;
  }, [revision, active]);

  const onScroll = useCallback<UIEventHandler<T>>((event) => {
    const el = event.currentTarget;
    // Our own jump dispatches this event later, by which time another row may already
    // have landed below the slop — read as "the reader scrolled away", following would
    // silently stop for the rest of the run.
    if (synthetic.current) {
      synthetic.current = false;
      // The jump was ours and it went to the bottom, so keep following; a row that
      // landed in the meantime is what the next `revision` bump scrolls to.
      stuck.current = true;
      return;
    }
    stuck.current = isScrollAtBottom(
      el.scrollHeight,
      el.scrollTop,
      el.clientHeight,
    );
  }, []);

  return { ref, onScroll };
}
