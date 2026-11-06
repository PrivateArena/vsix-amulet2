import { describe, expect, it } from 'vitest';
import type {
  CompactionEntry,
  CompactionSummaryMessage,
  HistoryMessage,
  SessionEntryRef,
} from './protocol';
import {
  branchEntries,
  collectContextEdits,
  compactionBoundaryList,
  compactionBoundaryOf,
  compactionDetailOf,
  isBeforeCompactionCutoff,
  isContextEditEntry,
  newestCompactionCutoff,
  stripCompactionBoundaries,
  type SessionEntryLike,
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

const line = (
  id: string,
  parentId: string | null,
  over: Partial<SessionEntryLike> = {},
): SessionEntryLike => ({
  type: 'message',
  id,
  parentId,
  ...over,
});

const edit = (
  id: string,
  parentId: string | null,
  targetId: string,
  replacement: { content?: unknown } | null,
): SessionEntryLike =>
  line(id, parentId, { type: 'context_edit', targetId, replacement });

describe('collectContextEdits', () => {
  it('keeps the newest edit of one target, in branch order', () => {
    // Omit, then restore: the second line is what the projection of the branch says.
    const entries = [
      line('u1', null),
      line('a1', 'u1'),
      edit('e1', 'a1', 'a1', null),
      line('u2', 'e1'),
      edit('e2', 'u2', 'a1', { content: 'back again' }),
    ];
    const edits = collectContextEdits(entries, 'e2');
    expect([...edits.keys()]).toEqual(['a1']);
    expect(edits.get('a1')?.id).toBe('e2');
    expect(edits.get('a1')?.replacement).toEqual({ content: 'back again' });
  });

  it('ignores an edit on a branch the conversation did not take', () => {
    // `x2` is where the user forked away, so the omission made on the other branch is not part of
    // this history — and the one made here is.
    const entries = [
      line('u1', null),
      line('a1', 'u1'),
      edit('e1', 'a1', 'a1', null),
      line('u2', 'e1'),
      line('x1', 'u1'),
      line('x2', 'x1'),
      edit('e9', 'x2', 'x1', null),
    ];
    expect([...collectContextEdits(entries, 'u2').keys()]).toEqual(['a1']);
    expect([...collectContextEdits(entries, 'e9').keys()]).toEqual(['x1']);
  });

  it('skips a line that claims to be an edit but names no target', () => {
    const broken = line('e1', null, { type: 'context_edit' });
    expect(isContextEditEntry(broken)).toBe(false);
    expect(collectContextEdits([broken], 'e1').size).toBe(0);
  });
});

describe('newestCompactionCutoff / isBeforeCompactionCutoff', () => {
  const branch = [
    line('u1', null),
    edit('e1', 'u1', 'u1', null),
    line('u2', 'e1'),
    line('c1', 'u2', { type: 'compaction', firstKeptEntryId: 'u2' }),
    line('u3', 'c1'),
    line('c2', 'u3', { type: 'compaction', firstKeptEntryId: 'u3' }),
  ];

  it('is undefined for a branch that never compacted', () => {
    expect(
      newestCompactionCutoff([line('u1', null), line('a1', 'u1')], 'a1'),
    ).toBeUndefined();
    expect(isBeforeCompactionCutoff([line('u1', null)], 'u1', 'u1')).toBe(
      false,
    );
  });

  it('names the newest boundary and the entries it summarised away', () => {
    expect(newestCompactionCutoff(branch, 'c2')).toBe('c2');
    // The newest boundary kept from `u3`, so both edits older than that are out of context.
    expect(isBeforeCompactionCutoff(branch, 'c2', 'u1')).toBe(true);
    expect(isBeforeCompactionCutoff(branch, 'c2', 'e1')).toBe(true);
    expect(isBeforeCompactionCutoff(branch, 'c2', 'u3')).toBe(false);
    expect(isBeforeCompactionCutoff(branch, 'c2', 'c2')).toBe(false);
    // An id from an abandoned branch is not "compacted away", it is just not here.
    expect(isBeforeCompactionCutoff(branch, 'c2', 'nope')).toBe(false);
  });

  it('treats a self-retaining boundary as keeping nothing older', () => {
    const selfRetained = [
      line('u1', null),
      line('c1', 'u1', { type: 'compaction', firstKeptEntryId: null }),
    ];
    expect(isBeforeCompactionCutoff(selfRetained, 'c1', 'u1')).toBe(true);
    expect(isBeforeCompactionCutoff(selfRetained, 'c1', 'c1')).toBe(false);
  });

  it('judges by the branch, not by the file', () => {
    const withSideBranch = [...branch, line('x1', 'u1')];
    // The old boundary `c1` is the newest one on the branch that ends at `x1`, and it kept `u2`.
    expect(newestCompactionCutoff(withSideBranch, 'x1')).toBeUndefined();
    expect(isBeforeCompactionCutoff(withSideBranch, 'x1', 'u1')).toBe(false);
  });
});
