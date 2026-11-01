import { describe, expect, it } from 'vitest';
import type { ContentBlock, Usage } from '../../../../shared/protocol';
import {
  countOutputTokens,
  estimateTokens,
  formatTokensPerSecond,
  NO_BASELINE,
  prefillTokensPerSecond,
  promptTokens,
  timeToFirstToken,
  windowRate,
  type RateSample,
} from './token-rate';

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  ...over,
});

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

describe('token-rate — output counting', () => {
  it('estimates tokens from characters', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(40)).toBe(10);
    expect(estimateTokens(-5)).toBe(0);
  });

  it('counts text, thinking and streamed tool arguments', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'aaaa' },
      { type: 'text', text: 'bbbbbb' },
      { type: 'toolCall', id: 'c1', name: 'bash', partialArgs: '{"comm' },
    ];
    expect(countOutputTokens('m1', blocks, undefined, NO_BASELINE).tokens).toBe(
      estimateTokens(4 + 6 + 6),
    );
  });

  it('anchors on reported usage and estimates only what follows', () => {
    // pi reports usage at block boundaries: 100 output tokens are known while the
    // message has produced 400 characters of them.
    const anchored = countOutputTokens(
      'm1',
      text('x'.repeat(400)),
      usage({ output: 100 }),
      NO_BASELINE,
    );
    expect(anchored.baseline).toEqual({
      uid: 'm1',
      tokens: 100,
      chars: 400,
    });
    expect(anchored.tokens).toBe(100);

    // More characters on the same message: the anchor holds, the excess is estimated.
    expect(
      countOutputTokens(
        'm1',
        text('x'.repeat(480)),
        usage({ output: 100 }),
        anchored.baseline,
      ).tokens,
    ).toBe(120);

    // A higher report moves the anchor; a lower one never does.
    expect(
      countOutputTokens(
        'm1',
        text('x'.repeat(500)),
        usage({ output: 130 }),
        anchored.baseline,
      ).baseline.tokens,
    ).toBe(130);
    expect(
      countOutputTokens(
        'm1',
        text('x'.repeat(500)),
        usage({ output: 10 }),
        anchored.baseline,
      ).baseline.tokens,
    ).toBe(100);
  });

  it('re-anchors for a different message instead of inheriting its predecessor', () => {
    const previous = countOutputTokens(
      'm1',
      text('x'.repeat(400)),
      usage({ output: 100 }),
      NO_BASELINE,
    );
    const next = countOutputTokens(
      'm2',
      text(''),
      undefined,
      previous.baseline,
    );
    expect(next.baseline).toEqual({ uid: 'm2', tokens: 0, chars: 0 });
    expect(next.tokens).toBe(0);
  });
});

describe('token-rate — rates', () => {
  const samples: RateSample[] = [
    { at: 0, tokens: 0 },
    { at: 1000, tokens: 10 },
    { at: 2000, tokens: 40 },
  ];

  it('differentiates samples over the trailing window', () => {
    expect(windowRate(samples, 2000, 4000)).toBeCloseTo(20);
  });

  it('drops samples that fell out of the window', () => {
    // With a 1.5s window the first sample no longer counts: 30 tokens in 1s.
    expect(windowRate(samples, 2000, 1500)).toBeCloseTo(30);
  });

  it('returns null while the window is too thin to mean anything', () => {
    expect(windowRate([], 1000, 4000)).toBeNull();
    expect(windowRate([{ at: 0, tokens: 5 }], 1000, 4000)).toBeNull();
    expect(
      windowRate(
        [
          { at: 1000, tokens: 0 },
          { at: 1200, tokens: 20 },
        ],
        1200,
        4000,
      ),
    ).toBeNull(); // span under the minimum
    expect(
      windowRate(
        [
          { at: 0, tokens: 0 },
          { at: 2000, tokens: 2 },
        ],
        2000,
        4000,
      ),
    ).toBeNull(); // too few tokens moved
  });

  it('sums uncached and cached prompt tokens for the prefill estimate', () => {
    expect(promptTokens(undefined)).toBe(0);
    expect(
      promptTokens(usage({ input: 100, cacheRead: 900, cacheWrite: 50 })),
    ).toBe(1050);
  });

  it('derives the prefill rate from time-to-first-token', () => {
    expect(prefillTokensPerSecond(usage({ input: 1000 }), 500)).toBeCloseTo(
      2000,
    );
    // Nothing measurable before the first token, and nothing meaningful in a tiny prompt.
    expect(
      prefillTokensPerSecond(usage({ input: 1000 }), undefined),
    ).toBeNull();
    expect(prefillTokensPerSecond(undefined, 500)).toBeNull();
    expect(prefillTokensPerSecond(usage({ input: 10 }), 500)).toBeNull();
    expect(prefillTokensPerSecond(usage({ input: 1000 }), 20)).toBeNull();
  });

  it('measures time-to-first-token only when both stamps exist', () => {
    expect(timeToFirstToken(1000, 1400)).toBe(400);
    expect(timeToFirstToken(1000, undefined)).toBeUndefined();
    expect(timeToFirstToken(undefined, 1400)).toBeUndefined();
    expect(timeToFirstToken(1400, 1000)).toBe(0);
  });

  it('formats rates compactly', () => {
    expect(formatTokensPerSecond(52.4)).toBe('52');
    expect(formatTokensPerSecond(999.5)).toBe('1.0k');
    expect(formatTokensPerSecond(1600)).toBe('1.6k');
  });
});
