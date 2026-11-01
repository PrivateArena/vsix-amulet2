import { describe, expect, it } from 'vitest';
import {
  isOwnFollowScroll,
  isScrollAtBottom,
  stickSlop,
} from './use-stick-to-bottom';

// The DOM half of the hook is a `scrollTop` write and an event handler; what carries
// the decision — follow, or leave the reader alone — is these two measurements.
describe('isScrollAtBottom', () => {
  it('is true at the bottom and while a partial row is still below the fold', () => {
    expect(isScrollAtBottom(1000, 800, 200)).toBe(true);
    expect(isScrollAtBottom(1000, 790, 200)).toBe(true);
    expect(isScrollAtBottom(1000, 777, 200)).toBe(true);
  });

  it('is false once the reader has scrolled past the slop', () => {
    expect(isScrollAtBottom(1000, 776, 200)).toBe(false);
    expect(isScrollAtBottom(1000, 0, 200)).toBe(false);
  });

  it('is true for a list that does not scroll at all', () => {
    expect(isScrollAtBottom(200, 0, 200)).toBe(true);
  });
});

// The geometry of a streaming `write` card, as the stylesheet lays it out: 16 preview rows of
// ~20px (`0.85em` on the card's `0.93em`, line-height 1.5, 4px of padding) against the 200px
// box it gets, less the horizontal scrollbar a long line raises.
const PREVIEW_HEIGHT = 320;
const STREAM_BOX = 192;
const PREVIEW_ROW = 20;

describe('stickSlop', () => {
  it('falls back to its floor for a list whose rows could not be measured', () => {
    expect(stickSlop()).toBe(24);
    expect(stickSlop(0, 0)).toBe(24);
    expect(stickSlop(8, 400)).toBe(24);
  });

  it('is a row and a half of the list, so a slide of the tail window keeps the follow', () => {
    const slop = stickSlop(PREVIEW_ROW, STREAM_BOX);
    expect(slop).toBe(30);
    // The window slid one row off the top and landed one at the bottom.
    expect(
      isScrollAtBottom(
        PREVIEW_HEIGHT,
        PREVIEW_HEIGHT - STREAM_BOX - PREVIEW_ROW,
        STREAM_BOX,
        slop,
      ),
    ).toBe(true);
    // Two rows up is not bookkeeping any more: that is a reader looking at the head of the file.
    expect(
      isScrollAtBottom(
        PREVIEW_HEIGHT,
        PREVIEW_HEIGHT - STREAM_BOX - 2 * PREVIEW_ROW,
        STREAM_BOX,
        slop,
      ),
    ).toBe(false);
    // And a wheel is certainly not.
    expect(isScrollAtBottom(PREVIEW_HEIGHT, 40, STREAM_BOX, slop)).toBe(false);
  });

  it('is bounded by the box, because a row is not always small', () => {
    // The newest row of a nested call list is holding an opened result: slack as long as that
    // would leave no position that counts as scrolled away, and the reader could not get free.
    const slop = stickSlop(200, 220);
    expect(slop).toBe(73);
    expect(isScrollAtBottom(480, 100, 220, slop)).toBe(false);
  });
});

describe('isOwnFollowScroll', () => {
  it('claims the position the follow itself wrote, and anything further down', () => {
    expect(isOwnFollowScroll(128, 128)).toBe(true);
    // Sub-pixel client rects, and a row that landed between the jump and its event.
    expect(isOwnFollowScroll(127, 128)).toBe(true);
    expect(isOwnFollowScroll(140, 128)).toBe(true);
  });

  it('leaves a scroll above that position to the reader', () => {
    expect(isOwnFollowScroll(126, 128)).toBe(false);
    expect(isOwnFollowScroll(0, 128)).toBe(false);
  });

  it('claims nothing while no jump is outstanding', () => {
    // -1, and 0, which is where a box that never scrolled would sit.
    expect(isOwnFollowScroll(0, -1)).toBe(false);
    expect(isOwnFollowScroll(0, 0)).toBe(false);
    expect(isOwnFollowScroll(64, -1)).toBe(false);
  });
});
