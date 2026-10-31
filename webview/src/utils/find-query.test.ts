import { describe, expect, it } from 'vitest';
import {
  MAX_MATCHES,
  compileFindQuery,
  findMatches,
  formatFindCount,
} from './find-query';

const offsets = (haystack: string, query: string) =>
  findMatches(haystack, query).matches.map((m) => m.start);

describe('find-query', () => {
  it('finds plain matches case-insensitively by default', () => {
    const haystack =
      'spawned a SubAgent, then the sub agent called subagent again';
    expect(offsets(haystack, 'subagent')).toEqual([
      haystack.indexOf('SubAgent'),
      haystack.lastIndexOf('subagent'),
    ]);
  });

  it('matches text split across inline markup but not across blocks', () => {
    // `chat-find/transcript-index` joins inline text nodes directly and puts a `\n`
    // between blocks — these are the two offsets that rule produces.
    const inline = 'read the sub\nagent output';
    expect(offsets(inline, 'subagent')).toEqual([]);
    expect(offsets('read the subagent output', 'sub agent')).toEqual([]);
  });

  it('honours match case', () => {
    const haystack = 'SubAgent subagent';
    expect(
      findMatches(haystack, 'subagent', { caseSensitive: true }).matches,
    ).toEqual([{ start: 9, length: 8 }]);
  });

  it('treats regex metacharacters as literal text outside regex mode', () => {
    expect(offsets('cost is 3.5 (USD)', '3.5 (USD)')).toEqual([
      'cost is 3.5 (USD)'.indexOf('3.5 (USD)'),
    ]);
    expect(findMatches('aaa', 'a+').matches).toHaveLength(0);
  });

  it('supports patterns in regex mode', () => {
    const haystack = 'subagent_call and SUBAGENT_2 ran';
    expect(
      findMatches(haystack, 'subagent_\\w', { regex: true }).matches,
    ).toEqual([
      { start: 0, length: 10 },
      { start: 18, length: 10 },
    ]);
  });

  it('reports an invalid regex instead of throwing', () => {
    const hits = findMatches('text', '(unclosed', { regex: true });
    expect(hits.matches).toEqual([]);
    expect(hits.error).toBeTypeOf('string');
    expect(compileFindQuery('(unclosed', { regex: true }).pattern).toBeNull();
  });

  it('ignores zero-length matches', () => {
    const hits = findMatches('abc', 'x*', { regex: true });
    expect(hits.matches).toEqual([]);
  });

  it('caps the result list', () => {
    const hits = findMatches('a'.repeat(MAX_MATCHES * 3), 'a');
    expect(hits.matches).toHaveLength(MAX_MATCHES);
    expect(hits.capped).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches('text', '').matches).toEqual([]);
    expect(compileFindQuery('').pattern).toBeNull();
  });

  it('formats the counter', () => {
    expect(formatFindCount(-1, 0, false)).toBe('0');
    expect(formatFindCount(0, 12, false)).toBe('1 / 12');
    expect(formatFindCount(11, 12, false)).toBe('12 / 12');
    expect(formatFindCount(0, MAX_MATCHES, true)).toBe(`1 / ${MAX_MATCHES}+`);
  });
});
