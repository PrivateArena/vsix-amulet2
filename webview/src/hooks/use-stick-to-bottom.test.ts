import { describe, expect, it } from 'vitest';
import { isScrollAtBottom } from './use-stick-to-bottom';

// The DOM half of the hook is a `scrollTop` write and an event handler; what carries
// the decision — follow, or leave the reader alone — is this measurement.
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
