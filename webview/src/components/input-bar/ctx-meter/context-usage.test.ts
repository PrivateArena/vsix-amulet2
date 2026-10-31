import { describe, expect, it } from 'vitest';
import type { SessionStats, Usage } from '../../../../../shared/protocol';
import type { UiMessage } from '../../../store';
import { contextTokensOf, contextUsageOf } from './context-usage';

const usage = (
  input: number,
  output: number,
  total = input + output,
): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: total,
});

const stats = (contextUsage?: SessionStats['contextUsage']): SessionStats => ({
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
  contextUsage,
});

const assistant = (streaming: boolean, u?: Usage): UiMessage => ({
  uid: 'a1',
  role: 'assistant',
  content: [],
  streaming,
  usage: u,
});

describe('contextTokensOf', () => {
  it('uses totalTokens, falling back to the sum of the buckets', () => {
    expect(contextTokensOf(usage(2880, 15))).toBe(2895);
    expect(
      contextTokensOf({ ...usage(2880, 15), totalTokens: 0, cacheRead: 40 }),
    ).toBe(2935);
  });

  it('treats an all-zero usage as "not reported yet"', () => {
    expect(contextTokensOf(undefined)).toBeNull();
    expect(contextTokensOf(usage(0, 0, 0))).toBeNull();
  });
});

describe('contextUsageOf', () => {
  it('needs a context window to say anything', () => {
    expect(contextUsageOf(null, [])).toBeNull();
    expect(contextUsageOf(stats(), [])).toBeNull();
    expect(
      contextUsageOf(stats({ tokens: 100, contextWindow: 0, percent: 0 }), []),
    ).toBeNull();
  });

  it('ignores a missing or nullish contextUsage (pi after a compaction)', () => {
    expect(
      contextUsageOf(stats({ tokens: 0, contextWindow: 0, percent: 0 }), []),
    ).toBeNull();
    expect(
      contextUsageOf({ ...stats(), contextUsage: undefined }, []),
    ).toBeNull();
  });

  it('reports the runtime figure when the agent is idle', () => {
    const view = contextUsageOf(
      stats({ tokens: 117_500, contextWindow: 470_592, percent: 24.97 }),
      [assistant(false, usage(9_999_999, 9_999_999))],
    );
    expect(view).toEqual({
      tokens: 117_500,
      contextWindow: 470_592,
      percent: 25,
      live: false,
    });
  });

  it('follows the streaming message instead of the stale baseline', () => {
    const view = contextUsageOf(
      stats({ tokens: 1000, contextWindow: 10_000, percent: 10 }),
      [
        assistant(false, usage(500, 500)),
        { ...assistant(true), uid: 'u1', role: 'user' },
        assistant(true, usage(4000, 600, 4600)),
      ],
    );
    expect(view?.tokens).toBe(4600);
    expect(view?.percent).toBe(46);
    expect(view?.live).toBe(true);
  });

  it('keeps the last known figure while the first deltas still carry zero usage', () => {
    const view = contextUsageOf(
      stats({ tokens: 1234, contextWindow: 10_000, percent: 12 }),
      [assistant(true, usage(0, 0, 0))],
    );
    expect(view?.tokens).toBe(1234);
    expect(view?.live).toBe(false);
  });

  it('clamps the percentage into 0..100', () => {
    const over = contextUsageOf(
      stats({ tokens: 12_000, contextWindow: 10_000, percent: 120 }),
      [],
    );
    expect(over?.percent).toBe(100);
  });
});
