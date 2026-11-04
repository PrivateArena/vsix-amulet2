import { describe, expect, it } from 'vitest';
import type { CompactionBoundary } from '../../../../../shared/protocol';
import {
  compactionInfoOf,
  compactionMetaLine,
  compactionOrdinalOf,
} from './compaction-view';

const boundary = (
  over: Partial<CompactionBoundary> = {},
): CompactionBoundary => ({
  id: 'c1',
  timestamp: 1_700_000_000_000,
  tokensBefore: 204_146,
  readCount: 0,
  modifiedCount: 0,
  hasSummary: true,
  ...over,
});

/**
 * The wording shared by the compact-history list and its dialog. `formatTokens` is the same
 * formatter the context meter uses, so a boundary says the same size in both places.
 */
describe('compactionMetaLine', () => {
  it('leads with the context the summary replaced', () => {
    expect(compactionMetaLine(boundary())).toBe('204.1k in context');
  });

  it('adds the file counts the row has room for', () => {
    expect(
      compactionMetaLine(boundary({ readCount: 7, modifiedCount: 2 })),
    ).toBe('204.1k in context · 7 read · 2 edited');
  });

  it('says nothing was recorded rather than showing a bare separator', () => {
    expect(
      compactionMetaLine(boundary({ tokensBefore: 0, readCount: 0 })),
    ).toBe('no detail recorded');
  });
});

describe('compactionOrdinalOf', () => {
  it('counts up while the list runs newest first', () => {
    // Three boundaries, newest at the top: the top row is #3, the last is #1.
    expect([0, 1, 2].map((i) => compactionOrdinalOf(3, i))).toEqual([3, 2, 1]);
  });
});

describe('compactionInfoOf', () => {
  it('maps a persisted entry onto the card, without inventing what it never stored', () => {
    const info = compactionInfoOf({
      id: 'c1',
      timestamp: 1_700_000_000_000,
      tokensBefore: 204_146,
      summary: '## Goal ...',
      readFiles: ['/a.ts'],
      modifiedFiles: ['/b.ts'],
    });
    expect(info).toMatchObject({
      outcome: 'done',
      reason: null,
      endedAt: 1_700_000_000_000,
      summary: '## Goal ...',
      tokensBefore: 204_146,
      readFiles: ['/a.ts'],
      modifiedFiles: ['/b.ts'],
    });
    // No trigger, no duration, no post-compaction estimate: pi persists none of them, and a
    // figure the entry does not hold must not be guessed into the card.
    expect(info.durationMs).toBeUndefined();
    expect(info.tokensAfter).toBeUndefined();
  });
});
