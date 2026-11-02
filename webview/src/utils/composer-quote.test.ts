import { describe, expect, it } from 'vitest';
import { appendToDraft, toBlockquote } from './composer-quote';

describe('toBlockquote', () => {
  it('prefixes every line, keeping blank lines as bare markers', () => {
    expect(toBlockquote('one\n\ntwo\n')).toBe('> one\n>\n> two');
  });

  it('keeps nested structure inside the quote', () => {
    expect(toBlockquote('- a\n- b')).toBe('> - a\n> - b');
  });

  it('is empty for whitespace', () => {
    expect(toBlockquote('   \n \n')).toBe('');
  });
});

describe('appendToDraft', () => {
  it('starts a draft with the block and a fresh line to answer on', () => {
    expect(appendToDraft('', '> quoted\n')).toBe('> quoted\n');
    expect(appendToDraft('   ', '> q')).toBe('> q\n');
  });

  it('separates the block from what the user already typed', () => {
    expect(appendToDraft('fix it', '> q')).toBe('fix it\n\n> q\n');
    expect(appendToDraft('fix it\n', '> q')).toBe('fix it\n\n> q\n');
    expect(appendToDraft('fix it\n\n', '> q')).toBe('fix it\n\n> q\n');
  });

  it('does nothing without a block', () => {
    expect(appendToDraft('keep', '')).toBe('keep');
  });
});
