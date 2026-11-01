import { describe, expect, it } from 'vitest';
import {
  WRITE_PREVIEW_LINES,
  buildWritePreview,
  writeLineBadge,
} from './write-preview';

describe('buildWritePreview', () => {
  it('shows the whole body while it fits the window', () => {
    expect(buildWritePreview('a\nb\nc')).toEqual({
      lines: ['a', 'b', 'c'],
      skipped: 0,
      totalLines: 3,
    });
  });

  it('counts a blank line the file really ends with', () => {
    expect(buildWritePreview(undefined)).toEqual({
      lines: [],
      skipped: 0,
      totalLines: 0,
    });
    expect(buildWritePreview('\n\n')).toEqual({
      lines: ['', ''],
      skipped: 0,
      totalLines: 2,
    });
  });

  it('keeps an unfinished last line, and blank lines inside the body', () => {
    expect(buildWritePreview('a\n\nb\nli')).toEqual({
      lines: ['a', '', 'b', 'li'],
      skipped: 0,
      totalLines: 4,
    });
  });

  it('slides a tail window over a long body', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const preview = buildWritePreview(body, 24);
    expect(preview.totalLines).toBe(200);
    expect(preview.skipped).toBe(176);
    expect(preview.lines).toHaveLength(24);
    expect(preview.lines[0]).toBe('line 176');
    expect(preview.lines.at(-1)).toBe('line 199');
  });

  it('defaults to the window the card is built around', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(buildWritePreview(body).lines).toHaveLength(WRITE_PREVIEW_LINES);
  });

  it('counts one closing line ending as the end of the last line', () => {
    expect(buildWritePreview('a\nb\n').totalLines).toBe(2);
    expect(buildWritePreview('a\nb\n\n').totalLines).toBe(3);
  });

  it('normalizes line endings', () => {
    expect(buildWritePreview('a\r\nb\rc').lines).toEqual(['a', 'b', 'c']);
  });
});

describe('writeLineBadge', () => {
  it('counts the body, singular first', () => {
    expect(writeLineBadge('')).toBe('');
    expect(writeLineBadge(undefined)).toBe('');
    expect(writeLineBadge('one line')).toBe('+1 line');
    expect(writeLineBadge('one\ntwo\nthree\n')).toBe('+3 lines');
  });
});
