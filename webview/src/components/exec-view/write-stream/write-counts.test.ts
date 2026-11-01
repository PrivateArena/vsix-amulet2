import { describe, expect, it } from 'vitest';
import { writeLineBadge } from './write-counts';

describe('writeLineBadge', () => {
  it('counts the body, singular first', () => {
    expect(writeLineBadge('')).toBe('');
    expect(writeLineBadge(undefined)).toBe('');
    expect(writeLineBadge('one line')).toBe('+1 line');
    expect(writeLineBadge('one\ntwo\nthree\n')).toBe('+3 lines');
  });
});
