/**
 * Scroll plumbing for quick-find. Split out of the component so {@link EntryList},
 * which owns transcript scrolling (and the "hugging the bottom" state), can reuse it.
 */

/** Where a revealed match lands in the viewport, as a fraction of its height. */
const REVEAL_ALIGN = 0.32;

/**
 * Scroll `container` so the given ranges sit near the top third of the view.
 * Already-visible matches are left alone — jumping the view 40px to "center" a line
 * the user is looking at is worse than not scrolling.
 *
 * Returns whether a scroll happened.
 */
export function scrollRangesIntoView(
  ranges: Range[],
  container: HTMLElement,
): boolean {
  let top = Infinity;
  let bottom = -Infinity;
  for (const range of ranges) {
    const rect = range.getBoundingClientRect();
    // Zero-size rects mean the match lives in clipped or unmounted content.
    if (rect.width === 0 && rect.height === 0) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (top === Infinity) return false;

  const box = container.getBoundingClientRect();
  const margin = 12;
  if (top >= box.top + margin && bottom <= box.bottom - margin) return false;

  const target =
    container.scrollTop +
    (top - box.top - container.clientHeight * REVEAL_ALIGN);
  container.scrollTo({ top: Math.max(0, target) });
  return true;
}
