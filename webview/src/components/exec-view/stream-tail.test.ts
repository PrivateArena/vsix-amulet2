import { describe, expect, it } from 'vitest';
import {
  STREAM_TAIL_LINES,
  buildStreamTail,
  countStreamLines,
} from './stream-tail';

describe('buildStreamTail', () => {
  it('shows the whole text while it fits the window', () => {
    expect(buildStreamTail('a\nb\nc')).toEqual({
      lines: ['a', 'b', 'c'],
      skipped: 0,
      totalLines: 3,
    });
  });

  it('counts a blank line the text really ends with', () => {
    expect(buildStreamTail(undefined)).toEqual({
      lines: [],
      skipped: 0,
      totalLines: 0,
    });
    expect(buildStreamTail('\n\n')).toEqual({
      lines: ['', ''],
      skipped: 0,
      totalLines: 2,
    });
  });

  it('keeps an unfinished last line, and blank lines inside the body', () => {
    expect(buildStreamTail('a\n\nb\nli')).toEqual({
      lines: ['a', '', 'b', 'li'],
      skipped: 0,
      totalLines: 4,
    });
  });

  it('slides a tail window over a long body', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const tail = buildStreamTail(body, 24);
    expect(tail.totalLines).toBe(200);
    expect(tail.skipped).toBe(176);
    expect(tail.lines).toHaveLength(24);
    expect(tail.lines[0]).toBe('line 176');
    expect(tail.lines.at(-1)).toBe('line 199');
  });

  it('defaults to the window the card is built around', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(buildStreamTail(body).lines).toHaveLength(STREAM_TAIL_LINES);
  });

  it('counts one closing line ending as the end of the last line', () => {
    expect(buildStreamTail('a\nb\n').totalLines).toBe(2);
    expect(buildStreamTail('a\nb\n\n').totalLines).toBe(3);
  });

  it('normalizes line endings', () => {
    expect(buildStreamTail('a\r\nb\rc').lines).toEqual(['a', 'b', 'c']);
  });
});

describe('countStreamLines', () => {
  it('counts the whole text, not the window', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(countStreamLines(body)).toBe(200);
    expect(buildStreamTail(body).lines.length).toBeLessThan(200);
  });

  it('counts nothing in nothing', () => {
    expect(countStreamLines('')).toBe(0);
    expect(countStreamLines(undefined)).toBe(0);
  });
});
