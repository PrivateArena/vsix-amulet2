import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
  type UIEventHandler,
} from 'react';

/** The floor for the bottom margin, for a list whose rows could not be measured. */
const BOTTOM_SLOP_PX = 24;

/** Rows of slack a follow tolerates before it treats the reader as gone. */
const SLOP_ROWS = 1.5;

/** Of the visible box, the most that slack may be: further up is nowhere near the newest row. */
const SLOP_VIEWPORT_SHARE = 1 / 3;

/** Sub-pixel tolerance: a measurement is ours when it is within this of what we wrote. */
const MEASURE_SLOP_PX = 1;

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

/**
 * How far below the bottom the view may sit and still count as following.
 *
 * Measured in rows rather than in a fixed pixel margin, because a streamed list moves in
 * whole rows: a tail window slides a row off the top, a caret row arrives at the bottom, and
 * the follow has to survive both. A constant small enough to notice a real scroll-up is also
 * small enough to mistake that bookkeeping for one — which it only ever has to judge once the
 * content overflows, i.e. exactly when the follow starts to matter.
 *
 * Bounded by what the reader can see, because a row is not always small: a nested row with an
 * output block open is taller than the box that holds it, and slack that long would leave no
 * position that counts as scrolled away.
 *
 * Both measurements come from the caller, so the slack follows the reader's font and zoom.
 */
export function stickSlop(rowHeight = 0, clientHeight = 0): number {
  const byRow = Math.round(rowHeight * SLOP_ROWS);
  const share =
    clientHeight > 0
      ? Math.round(clientHeight * SLOP_VIEWPORT_SHARE)
      : Number.POSITIVE_INFINITY;
  return Math.min(
    Math.max(BOTTOM_SLOP_PX, byRow),
    Math.max(BOTTOM_SLOP_PX, share),
  );
}

/**
 * Whether a scroll position is where our own follow left the box.
 *
 * A follow only ever moves a list down, so a position at or below the last one it wrote can be
 * nothing else — and a list that keeps being judged as though it were the reader's doing either
 * loses the grip mid-run or never notices that the reader has taken the scroll.
 */
export function isOwnFollowScroll(
  scrollTop: number,
  writtenTop: number,
): boolean {
  return writtenTop > 0 && scrollTop >= writtenTop - MEASURE_SLOP_PX;
}

/** The height of the newest row — the unit a streamed list moves in; 0 when it has none. */
function lastRowHeight(el: HTMLElement): number {
  const last = el.lastElementChild;
  return last ? (last as HTMLElement).offsetHeight : 0;
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
 *
 * A box that shows a sliding tail window (rows dropped off the top as others arrive below)
 * should also opt out of CSS scroll anchoring, `overflow-anchor: none`: the browser's own
 * adjustment is reported as a `scroll` event, and an adjustment of more than the slack reads
 * here as the reader having scrolled away.
 */
export function useStickToBottom<T extends HTMLElement>(
  revision: unknown,
  active = true,
): StickToBottom<T> {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  /** Where our own last jump left the box, or -1 while none is outstanding. */
  const writtenTop = useRef(-1);
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
    if (distance <= MEASURE_SLOP_PX) return;
    el.scrollTop = el.scrollHeight;
    // Read back, so this is the clamped position the resulting `scroll` event reports. A jump
    // that moved nothing queues no event and leaves nothing outstanding, hence the `> 0` test.
    writtenTop.current = el.scrollTop;
  }, [revision, active]);

  const onScroll = useCallback<UIEventHandler<T>>((event) => {
    const el = event.currentTarget;
    // The event our own jump queued. Judged by position rather than by a flag, because a flag
    // is one slot for however many jumps a frame takes: Chromium dispatches at most one `scroll`
    // event per element per frame, so with several jumps in a frame it is cleared once and left
    // set for the reader's next scroll — in the other direction, an event that arrives without
    // the flag set reads as a scroll away from the bottom and drops the grip for the run.
    const written = writtenTop.current;
    // Either it has just reported or a later jump superseded it. Carrying a jump's position over
    // into an unrelated scroll would swallow the reader's gesture — and one swallowed event is a
    // re-engagement (an `End`, a scrollbar click) that never gets judged.
    writtenTop.current = -1;
    if (isOwnFollowScroll(el.scrollTop, written)) {
      // Where we left it, so still following: a row that landed since then is what the next
      // `revision` bump scrolls to.
      stuck.current = true;
      return;
    }
    stuck.current = isScrollAtBottom(
      el.scrollHeight,
      el.scrollTop,
      el.clientHeight,
      stickSlop(lastRowHeight(el), el.clientHeight),
    );
  }, []);

  return { ref, onScroll };
}
