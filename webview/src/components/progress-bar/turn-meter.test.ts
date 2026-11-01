import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContentBlock,
  HostMessage,
  RpcEvent,
  Usage,
} from '../../../../shared/protocol';
import { initialState, reducer } from '../../store';
import { createTurnMeter, NO_RATES, type MeteredMessage } from './turn-meter';

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  ...over,
});

const blocks = (chars: number): ContentBlock[] => [
  { type: 'text', text: 'x'.repeat(chars) },
];

const message = (over: Partial<MeteredMessage> = {}): MeteredMessage => ({
  uid: 'a1',
  content: [],
  ...over,
});

describe('turn meter', () => {
  it('stays silent without a streaming message or output', () => {
    const meter = createTurnMeter();
    expect(meter.measure(0, null)).toEqual(NO_RATES);
    expect(meter.measure(1000, message())).toEqual(NO_RATES);
    expect(meter.measure(5000, message({ content: blocks(8) }))).toEqual(
      NO_RATES,
    );
  });

  it('reports the decode rate of a steady stream', () => {
    const meter = createTurnMeter();
    // 40 characters (10 tokens) per second, ticked every second; the first tick
    // only plants a sample, since one sample is not a rate.
    meter.measure(1000, message({ content: blocks(40) }));
    for (let at = 2000; at <= 6000; at += 1000) {
      expect(
        meter.measure(at, message({ content: blocks(40 * (at / 1000)) }))
          .decode,
      ).toBeCloseTo(10, 0);
    }
  });

  it('keeps one continuous rate across the messages of a turn', () => {
    const meter = createTurnMeter();
    // Two messages of 10 tokens each a second apart: the turn runs at 10 tokens/second.
    expect(
      meter.measure(1000, message({ content: blocks(40) })).decode,
    ).toBeNull();
    expect(
      meter.measure(2000, message({ uid: 'a2', content: blocks(40) })).decode,
    ).toBeNull(); // the window restarts with the new API call
    expect(
      meter.measure(3000, message({ uid: 'a2', content: blocks(80) })).decode,
    ).toBeCloseTo(10, 0);
  });

  it('never lets a rate span the gap between two API calls', () => {
    const meter = createTurnMeter();
    meter.measure(1000, message({ content: blocks(400) })); // 100 tokens
    // A tool runs for a second and a half, then the next message starts.
    const rates = meter.measure(
      2500,
      message({ uid: 'a2', content: blocks(40) }),
    );
    expect(rates.decode).toBeNull();
    expect(
      meter.measure(3000, message({ uid: 'a2', content: blocks(60) })).decode,
    ).toBeCloseTo(10, 0); // 5 tokens in the 500ms since the first sample of a2
  });

  it('retires both rates while the model is not generating', () => {
    const meter = createTurnMeter();
    meter.measure(
      1000,
      message({
        content: blocks(40),
        usage: usage({ input: 1000 }),
        startedAt: 500,
        firstTokenAt: 1000,
      }),
    );
    const streaming = meter.measure(
      2000,
      message({
        content: blocks(80),
        usage: usage({ input: 1000 }),
        startedAt: 500,
        firstTokenAt: 1000,
      }),
    );
    expect(streaming.decode).not.toBeNull();
    expect(streaming.prefill).toBeCloseTo(2000, 0);
    // A tool call: nothing arrives, so neither reading describes the current speed.
    expect(meter.measure(6000, null)).toEqual(NO_RATES);
  });

  it('derives the prefill rate once usage and the first token are both known', () => {
    const meter = createTurnMeter();
    const streaming = message({
      content: blocks(40),
      usage: usage({ input: 1000 }),
      startedAt: 1000,
      firstTokenAt: 1500,
    });
    // 1000 prompt tokens in 500ms.
    expect(meter.measure(1600, streaming).prefill).toBeCloseTo(2000, 0);
    // Nothing measurable before the first token arrives.
    const fresh = createTurnMeter();
    expect(
      fresh.measure(1600, message({ content: blocks(40), startedAt: 1600 }))
        .prefill,
    ).toBeNull();
  });
});

describe('turn meter — replayed wire events', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const host = (event: RpcEvent) => ({
    type: 'host' as const,
    message: { type: 'rpcEvent', event } satisfies HostMessage,
  });

  it('measures decode and prefill out of the reducer state of a real stream', () => {
    // The shape pi 1.x sends: zeroed usage on every delta, the real figures only at the
    // first `*_end`, and nothing at all that carries a timestamp.
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let state = reducer(
      initialState,
      host({
        type: 'message_start',
        message: { role: 'assistant', content: [], usage: usage() },
      }),
    );
    const target = () =>
      state.messages.find((m) => m.uid === state.currentUid) ?? null;
    const meter = createTurnMeter();
    expect(meter.measure(Date.now(), target())).toEqual(NO_RATES);

    const rates = [600, 1600, 2600, 3600].map((at, i) => {
      vi.setSystemTime(1000 + at);
      state = reducer(
        state,
        host({
          type: 'message_update',
          // The last delta is the block end, where the runtime reports usage at last.
          usage: i === 3 ? usage({ input: 1000, output: 60 }) : usage(),
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'x'.repeat(60),
          },
        }),
      );
      return meter.measure(Date.now(), target());
    });

    const message = state.messages[0];
    expect(message.firstTokenAt! - message.startedAt!).toBe(600);
    expect(rates[0].decode).toBeNull();
    expect(rates[1].decode).toBeCloseTo(15, 0); // 60 characters per second
    expect(rates[3].decode).toBeCloseTo(15, 0);
    // 1000 prompt tokens before that first token: 1000 / 0.6s.
    expect(rates[3].prefill).toBeCloseTo(1000 / 0.6, -1);

    // The message settles and the turn goes quiet: the readout goes back to a duration.
    vi.setSystemTime(9000);
    state = reducer(
      state,
      host({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          usage: usage({ output: 60 }),
        },
      }),
    );
    state = reducer(state, host({ type: 'agent_end' }));
    expect(meter.measure(Date.now(), target())).toEqual(NO_RATES);
  });
});
