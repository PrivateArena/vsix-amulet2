import { describe, expect, it } from 'vitest';
import type { CompactionInfo, CompactionRun } from '../../../store';
import {
  compactionHint,
  compactionRetryLabel,
  compactionStats,
  compactionTitle,
} from './compaction-display';

const info = (patch: Partial<CompactionInfo>): CompactionInfo => ({
  outcome: 'done',
  reason: 'manual',
  endedAt: 0,
  ...patch,
});

describe('compactionTitle', () => {
  it('names the three outcomes apart', () => {
    expect(compactionTitle(info({}))).toBe('Context compacted');
    expect(compactionTitle(info({ outcome: 'aborted' }))).toBe(
      'Compaction cancelled',
    );
    expect(compactionTitle(info({ outcome: 'failed' }))).toBe(
      'Compaction failed',
    );
  });
});

describe('compactionStats', () => {
  it('reads the estimate as an estimate', () => {
    expect(
      compactionStats(
        info({
          tokensBefore: 150_000,
          tokensAfter: 32_000,
          durationMs: 75_000,
        }),
      ),
    ).toEqual(['150.0k → ~32.0k tokens', 'freed 118.0k (79%)', '1m 15s']);
  });

  it('says nothing it does not know', () => {
    // pi's persisted `compactionSummary` entry carries only the token count it replaced.
    expect(compactionStats(info({ tokensBefore: 148_000 }))).toEqual([
      '148.0k tokens in context',
    ]);
    expect(compactionStats(info({}))).toEqual([]);
  });

  it('marks the automatic compactions that the runtime decided on', () => {
    expect(
      compactionStats(info({ reason: 'threshold', tokensBefore: 1200 })),
    ).toContain('auto · context threshold');
    expect(
      compactionStats(info({ reason: 'overflow', tokensBefore: 1200 })),
    ).toContain('auto · context overflow');
  });
});

describe('compactionHint', () => {
  const run = (patch?: Partial<CompactionRun['retry']>): CompactionRun => ({
    reason: 'manual',
    startedAt: 0,
    retry: patch === undefined ? undefined : { ...patch },
  });

  it('names the stage while the first summary call is still running', () => {
    expect(compactionHint(run())).toBe('writing the summary');
  });

  it('counts retries the way pi does: the next call, over the retry budget', () => {
    expect(compactionHint(run({ attempt: 2, maxAttempts: 3 }))).toBe(
      'retrying (2/3)',
    );
    // Nothing received for the budget is nothing shown.
    expect(compactionHint(run({ attempt: 4 }))).toBe('retrying (4)');
    // An event without the counter must not invent one.
    expect(compactionHint(run({}))).toBe('retrying');
  });
});

describe('compactionRetryLabel', () => {
  it('says only "retrying" without a counter', () => {
    expect(
      compactionRetryLabel({ reason: null, startedAt: 0, retry: {} }),
    ).toBe('retrying');
  });
});
