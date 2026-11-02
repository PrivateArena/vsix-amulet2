import { describe, expect, it } from 'vitest';
import { popoverStyle } from './use-composer-anchor';

const rect = { left: 12, width: 340, top: 620 };

describe('popoverStyle', () => {
  it('floats the popup above the composer, gap clear of it', () => {
    // `bottom` is measured from the viewport floor, so a composer 620px down in an
    // 800px window leaves 180px under it, plus the gap.
    expect(popoverStyle(rect, 800)).toEqual({
      position: 'fixed',
      left: 12,
      width: 340,
      bottom: 188,
    });
  });

  it('keeps the gap adjustable for a caller that wants more air', () => {
    expect(popoverStyle(rect, 800, 0).bottom).toBe(180);
  });

  it('follows the composer when it grows upward', () => {
    // Typing a long path wraps the draft and moves `top`; the offset must shrink with it
    // or the menu ends up covering the text it is completing.
    const grown = { ...rect, top: 560 };
    expect(Number(popoverStyle(grown, 800).bottom)).toBeGreaterThan(
      Number(popoverStyle(rect, 800).bottom),
    );
  });
});
