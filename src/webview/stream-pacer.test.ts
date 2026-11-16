import { describe, expect, it } from 'vitest';
import { coalesceInto, StreamPacer, STREAM_PACE_MS } from './stream-pacer';
import { initialState, reducer, type ChatState } from '../../webview/src/store';
import type { RpcEvent } from '../../shared/protocol';

/** One streamed text delta of content slot `i`. */
const text = (i: number, delta: string, extra: Record<string, unknown> = {}): RpcEvent =>
  ({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: i, delta },
    ...extra,
  }) as RpcEvent;

const textEnd = (i: number, content: string): RpcEvent =>
  ({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_end', contentIndex: i, content },
  }) as RpcEvent;

/** A pacer with a hand-pulled clock, so no test sleeps. */
function harness() {
  const posted: RpcEvent[][] = [];
  const timers: Array<() => void> = [];
  const pacer = new StreamPacer({
    sink: (events) => posted.push(events),
    schedule: (cb) => {
      timers.push(cb);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    unschedule: () => {
      /* the fake clock never fires on its own */
    },
  });
  /** Run every armed timer once, as the host timer loop would. */
  const runDue = () => {
    const due = timers.splice(0, timers.length);
    for (const fire of due) fire();
  };
  const flat = () => posted.flat();
  return { pacer, posted, runDue, flat };
}

describe('StreamPacer', () => {
  it('forwards every event untouched while reduced motion is off', () => {
    const { pacer, posted, runDue } = harness();
    pacer.route(text(0, 'a'));
    pacer.route(text(0, 'b'));
    runDue();
    expect(posted).toEqual([[text(0, 'a') as never], [text(0, 'b') as never]]);
    expect(pacer.paces).toBe(false);
  });

  it('folds consecutive deltas of one content slot into a single chunk', () => {
    const { pacer, posted, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'Hel'));
    pacer.route(text(0, 'lo'));
    pacer.route(text(0, ' there'));
    expect(posted).toEqual([]);
    runDue();
    expect(posted.length).toBe(1);
    expect(flat()).toEqual([text(0, 'Hello there')]);
  });

  it('keeps slots and kinds apart instead of merging across them', () => {
    const { pacer, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'para one'));
    pacer.route(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' },
      } as RpcEvent,
    );
    pacer.route(text(0, ' still one'));
    runDue();
    expect(flat()).toEqual([
      text(0, 'para one'),
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'hmm' },
      } as never,
      text(0, ' still one'),
    ]);
  });

  it('folds the streamed argument buffer of a tool call', () => {
    const { pacer, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"fi' },
    } as RpcEvent);
    pacer.route({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'le":"a"}' },
    } as RpcEvent);
    runDue();
    expect(flat().length).toBe(1);
    expect(
      (flat()[0] as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
    ).toBe('{"file":"a"}');
  });

  it('keeps a closing event behind the fragment it closes, and never behind it', () => {
    const { pacer, posted, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'a'));
    pacer.route(textEnd(0, 'a'));
    expect(posted).toEqual([]);
    runDue();
    expect(posted.length).toBe(1);
    expect(
      flat().map(
        (e) =>
          (e as { assistantMessageEvent: { type: string } }).assistantMessageEvent
            .type,
      ),
    ).toEqual(['text_delta', 'text_end']);
  });

  it('flushes the pending chunk before a non-delta event, so the wire order survives', () => {
    const { pacer, flat } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'a'));
    pacer.route({ type: 'turn_end', message: {} } as RpcEvent);
    expect(flat().map((e) => e.type)).toEqual(['message_update', 'turn_end']);
  });

  it('keeps the newest usage counter of the folded chunk', () => {
    const { pacer, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'a', { usage: { input: 1 } }));
    pacer.route(text(0, 'b', { usage: { input: 9 } }));
    runDue();
    expect((flat()[0] as { usage: unknown }).usage).toEqual({ input: 9 });
  });

  it('never mutates the event object another surface also received', () => {
    const { pacer, runDue } = harness();
    pacer.setEnabled(true);
    const first = text(0, 'a');
    pacer.route(first);
    pacer.route(text(0, 'b'));
    runDue();
    expect(
      (first as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
    ).toBe('a');
  });

  it('drops superseded cumulative snapshots from an old runtime', () => {
    const { pacer, runDue, flat } = harness();
    pacer.setEnabled(true);
    pacer.route({ type: 'message_update', message: { content: 'a' } } as RpcEvent);
    pacer.route({ type: 'message_update', message: { content: 'ab' } } as RpcEvent);
    runDue();
    expect(flat()).toEqual([{ type: 'message_update', message: { content: 'ab' } } as never]);
  });

  it('hands the queue over when reduced motion is switched off', () => {
    const { pacer, posted } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'a'));
    pacer.setEnabled(false);
    expect(posted.length).toBe(1);
    expect(posted[0]).toEqual([text(0, 'a') as never]);
  });

  it('forgets the queue on stop without posting it to a dead surface', () => {
    const { pacer, posted } = harness();
    pacer.setEnabled(true);
    pacer.route(text(0, 'a'));
    pacer.stop();
    expect(posted).toEqual([]);
  });

  it('arms one timer per chunk', () => {
    const timers: Array<() => void> = [];
    const pacer = new StreamPacer({
      sink: () => {},
      schedule: (cb) => {
        timers.push(cb);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule: () => {},
    });
    pacer.setEnabled(true);
    pacer.route(text(0, 'a'));
    pacer.route(text(0, 'b'));
    expect(timers.length).toBe(1);
    timers[0]();
    pacer.route(text(0, 'c'));
    expect(timers.length).toBe(2);
  });

  it('defaults the chunk interval', () => {
    const pacer = new StreamPacer({ sink: () => {} });
    expect(pacer.paces).toBe(false);
    expect(STREAM_PACE_MS).toBeGreaterThan(0);
  });
});

describe('coalesceInto', () => {
  it('refuses an empty queue', () => {
    const queue: RpcEvent[] = [];
    expect(coalesceInto(queue, text(0, 'a'))).toBe(false);
    expect(queue).toEqual([]);
  });

  it('refuses a fragment that closes a slot', () => {
    const queue = [text(0, 'a')];
    expect(coalesceInto(queue, textEnd(0, 'a'))).toBe(false);
    expect(queue.length).toBe(1);
  });

  it('refuses a delta without text', () => {
    const queue = [text(0, 'a')];
    expect(coalesceInto(queue, text(0, undefined as unknown as string))).toBe(false);
    expect(
      (queue[0] as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
    ).toBe('a');
  });
});

/**
 * The contract that makes chunking legal: the webview reducer has to land on the same transcript
 * whether it is fed one event per token or the same events folded into chunks. It lives with the
 * pacer because the pacer is the only thing that could break it — and it reaches across the bundle
 * boundary on purpose, since the reducer is pure and the pacing is host-side.
 */
describe('a paced stream against the reducer', () => {
  const feed = (state: ChatState, event: RpcEvent) =>
    reducer(state, { type: 'host', message: { type: 'rpcEvent', event } });

  const toolCall = (i: number, delta: string): RpcEvent =>
    ({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: i, delta },
    }) as RpcEvent;

  const thinking = (i: number, delta: string): RpcEvent =>
    ({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: i, delta },
    }) as RpcEvent;

  /** One reply: prose, a reasoning block, a tool call whose arguments stream, then the runtime runs it. */
  const WIRE: RpcEvent[] = [
    { type: 'agent_start' } as RpcEvent,
    { type: 'message_start', message: { role: 'assistant', content: [] } } as RpcEvent,
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } } as RpcEvent,
    text(0, 'Hel'),
    text(0, 'lo '),
    text(0, 'wor'),
    text(0, 'ld'),
    { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello world' } } as RpcEvent,
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 1 } } as RpcEvent,
    thinking(1, 'thin'),
    thinking(1, 'k'),
    thinking(1, 'ing'),
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: 'thinking' } } as RpcEvent,
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 2,
        id: 'call_1',
        toolName: 'bash',
      },
    } as RpcEvent,
    toolCall(2, '{"command":'),
    toolCall(2, ' "echo hi"}'),
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 2,
        toolCall: { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hi' } },
      },
    } as RpcEvent,
    { type: 'message_end', message: { role: 'assistant', content: [] } } as RpcEvent,
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'echo hi' } } as RpcEvent,
    { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'hi' }] } } as RpcEvent,
    { type: 'turn_end', message: { role: 'assistant', content: [] } } as RpcEvent,
    { type: 'agent_end' } as RpcEvent,
  ];

  /** Drop the wall-clock stamps and the per-process uids, which differ between two passes by construction. */
  const withoutClock = (state: ChatState) =>
    JSON.parse(
      JSON.stringify(
        state.messages.map((m) => ({
          ...m,
          uid: '',
          timestamp: 0,
          startedAt: 0,
          firstTokenAt: 0,
        })),
      ),
    );

  it('builds the same transcript in chunks as it does token by token', () => {
    const direct = WIRE.reduce(feed, initialState);

    const chunks: RpcEvent[][] = [];
    let due: (() => void) | undefined;
    const pacer = new StreamPacer<RpcEvent>({
      sink: (events) => chunks.push(events),
      schedule: (cb) => {
        due = cb;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      unschedule: () => {
        due = undefined;
      },
    });
    pacer.setEnabled(true);
    // A frame boundary every three wire events, so the flushes interleave with the stream.
    WIRE.forEach((event, i) => {
      pacer.route(event);
      if (i % 3 === 2) {
        const fire = due;
        due = undefined;
        fire?.();
      }
    });
    pacer.flush();

    const paced = chunks.flat().reduce(feed, initialState);
    expect(withoutClock(paced)).toEqual(withoutClock(direct));
    // …and the paced pass really did arrive in fewer, fuller messages than the stream had events,
    // or the two transcripts would agree about a stream that was never chunked at all.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().length).toBeLessThan(WIRE.length);
  });
});
