import { describe, expect, it } from 'vitest';
import type {
  CompactionEntry,
  CompactionSummaryMessage,
  HistoryMessage,
  SessionEntryRef,
} from './protocol';
import {
  branchEntries,
  compactionBoundaryList,
  compactionBoundaryOf,
  compactionDetailOf,
  stripCompactionBoundaries,
} from './session-entries';

/**
 * The two questions the compact-history feature asks of pi's persisted entries: *which
 * compactions are on this branch*, and *what did one of them say*. `get_messages` can answer
 * neither — it returns the model-context projection, which keeps one boundary and no file lists.
 */

const ref = (id: string, parentId: string | null): SessionEntryRef => ({
  id,
  parentId,
});

const boundary = (
  id: string,
  parentId: string | null,
  over: Partial<CompactionEntry> = {},
): CompactionEntry => ({
  type: 'compaction',
  id,
  parentId,
  timestamp: '2026-11-02T16:37:44.052Z',
  summary: `summary of ${id}`,
  tokensBefore: 1000,
  ...over,
});

const projected = (
  tokensBefore: number,
  timestamp: number,
): CompactionSummaryMessage => ({
  role: 'compactionSummary',
  summary: `projected ${tokensBefore}`,
  tokensBefore,
  timestamp,
});

const ts = Date.parse('2026-11-02T16:37:44.052Z');

describe('branchEntries', () => {
  it('follows parentId, not file order', () => {
    // A fork: `c` was written after `b` but hangs off `a`, so a branch ending at `b` never saw it.
    const entries = [
      ref('a', null),
      ref('b', 'a'),
      ref('c', 'a'),
      ref('d', 'c'),
    ];
    expect(branchEntries(entries, 'b').map((e) => e.id)).toEqual(['a', 'b']);
    expect(branchEntries(entries, 'd').map((e) => e.id)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });

  it('survives a missing leaf and a cyclic parent link', () => {
    expect(branchEntries([ref('a', null)], 'zzz')).toEqual([]);
    expect(branchEntries([ref('a', null), ref('b', 'a')], null)).toEqual([]);
    const loop = [ref('a', 'b'), ref('b', 'a')];
    expect(branchEntries(loop, 'a').map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('stripCompactionBoundaries', () => {
  it('leaves a snapshot with no boundary alone', () => {
    const history: HistoryMessage[] = [
      { role: 'system', content: 'pi' },
      { role: 'user', content: 'hi' },
    ] as HistoryMessage[];
    expect(stripCompactionBoundaries(history)).toBe(history);
  });

  it('takes the projected boundary out, keeping every chat line in order', () => {
    const history: HistoryMessage[] = [
      { role: 'system', content: 'pi' },
      projected(204_146, ts),
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ] as HistoryMessage[];
    const next = stripCompactionBoundaries(history);
    expect(next.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    // Copy-on-change: the caller's array is never mutated.
    expect(history).toHaveLength(4);
  });
});

describe('compactionBoundaryOf', () => {
  it('reports a row without carrying the summary text', () => {
    const row = compactionBoundaryOf(
      boundary('c1', 'm1', {
        tokensBefore: 204_146,
        details: { readFiles: ['/a.ts', '/b.ts'], modifiedFiles: ['/c.ts'] },
      }),
    );
    expect(row).toEqual({
      id: 'c1',
      timestamp: ts,
      tokensBefore: 204_146,
      readCount: 2,
      modifiedCount: 1,
      hasSummary: true,
    });
    expect(JSON.stringify(row)).not.toContain('summary of');
  });

  it('tolerates the fields an older pi build leaves out', () => {
    const entry = boundary('c1', null);
    delete (entry as Partial<CompactionEntry>).tokensBefore;
    entry.timestamp = 'not a date';
    expect(compactionBoundaryOf(entry)).toMatchObject({
      tokensBefore: 0,
      timestamp: 0,
      readCount: 0,
      modifiedCount: 0,
    });
  });

  it('marks a boundary with no summary text as one that cannot be opened', () => {
    expect(
      compactionBoundaryOf(boundary('c1', null, { summary: '   ' })).hasSummary,
    ).toBe(false);
  });
});

describe('compactionDetailOf', () => {
  it('carries the summary and the file lists the projection drops', () => {
    const entry = boundary('c1', 'm1', {
      tokensBefore: 204_146,
      details: { readFiles: ['/a.ts'], modifiedFiles: ['/b.ts'] },
    });
    expect(compactionDetailOf(entry)).toEqual({
      id: 'c1',
      timestamp: ts,
      tokensBefore: 204_146,
      summary: 'summary of c1',
      readFiles: ['/a.ts'],
      modifiedFiles: ['/b.ts'],
      fromHook: undefined,
    });
  });

  it('does not send the fields nothing renders', () => {
    const entry = boundary('c1', null, {
      firstKeptEntryId: 'm40',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
      },
    });
    const detail = compactionDetailOf(entry);
    const keys = Object.keys(detail);
    expect(keys).not.toContain('firstKeptEntryId');
    expect(keys).not.toContain('usage');
    expect(keys).not.toContain('parentId');
  });
});

describe('compactionBoundaryList', () => {
  it('orders the list newest first, as a history reads', () => {
    // `readBranchCompactions` walks oldest → newest; the list inverts that and keeps the ordinals
    // counting up, so the newest boundary is #3 of 3.
    const list = compactionBoundaryList([
      boundary('c1', null, { tokensBefore: 1000 }),
      boundary('c2', 'c1', { tokensBefore: 2000 }),
      boundary('c3', 'c2', { tokensBefore: 3000 }),
    ]);
    expect(list.map((b) => b.tokensBefore)).toEqual([3000, 2000, 1000]);
  });

  it('is empty for a session that never compacted', () => {
    expect(compactionBoundaryList([])).toEqual([]);
  });
});
