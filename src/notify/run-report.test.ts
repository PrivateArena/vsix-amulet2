import { describe, expect, it } from 'vitest';
import type { AppMessage, RpcEvent } from '../../shared/protocol';
import { describeFinishedRun, RunWatcher } from './run-report';

/** A clock the watcher can be driven from. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** An assistant reply in the shape pi puts on the wire. */
function reply(text: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    ...extra,
  } as AppMessage;
}

/** One whole run: a tool turn, then the final report. Returns the last event's verdict. */
function feedRun(watcher: RunWatcher, final: AppMessage): RpcEvent[] {
  const events: RpcEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'turn_end',
      message: reply('let me look', { stopReason: 'toolUse' }),
      toolResults: [{ role: 'toolResult' }],
    },
    { type: 'turn_start' },
    { type: 'turn_end', message: final, toolResults: [] },
    { type: 'agent_end', messages: [{ role: 'user', content: 'hi' }, final] },
  ];
  const out: RpcEvent[] = [];
  for (const event of events) {
    const finished = watcher.feed(event);
    if (finished) out.push(event);
  }
  return out;
}

describe('RunWatcher', () => {
  it('reports the run exactly once, on agent_end', () => {
    const watcher = new RunWatcher();
    const hits = feedRun(
      watcher,
      reply('Fixed: the gate now rejects `git push`.'),
    );
    expect(hits.map((e) => e.type)).toEqual(['agent_end']);
  });

  it('carries the final report, not the intermediate tool turn', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'turn_end',
      message: reply('reading files', { stopReason: 'toolUse' }),
    });
    const finished = watcher.feed({
      type: 'turn_end',
      message: reply('all done, here is the summary'),
    });
    expect(finished).toBeNull();
    const done = watcher.feed({ type: 'agent_end', willRetry: false });
    expect(done?.report).toBe('all done, here is the summary');
    expect(done?.outcome).toBe('done');
  });

  it('reads the recap when the streamed turn_end never arrived', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    const done = watcher.feed({
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'hi' } as AppMessage,
        reply('from the recap'),
      ],
    });
    expect(done?.report).toBe('from the recap');
  });

  it('waits out a retry: the attempt that lands is the one that reports', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'turn_end',
      message: reply('', {
        stopReason: 'error',
        errorMessage: '429 rate limited',
      }),
    });
    expect(watcher.feed({ type: 'agent_end', willRetry: true })).toBeNull();
    watcher.feed({ type: 'agent_start' });
    const done = watcher.feed({
      type: 'agent_end',
      willRetry: false,
      messages: [reply('recovered')],
    });
    expect(done?.report).toBe('recovered');
    expect(done?.outcome).toBe('done');
  });

  it('stays silent when the human aborted the run', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'turn_end',
      message: reply('stopping', { stopReason: 'aborted' }),
    });
    expect(watcher.feed({ type: 'agent_end', willRetry: false })).toBeNull();
  });

  it('holds a provider failure until the run really ends, then says what failed', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'turn_end',
      message: reply('', {
        stopReason: 'error',
        errorMessage: 'overloaded: retry later',
      }),
    });
    // `agent_end` is not the end of the run here: compaction, truncation recovery and retry all re-enter
    // the loop behind it, and announcing now would call a working run a failed one.
    expect(watcher.feed({ type: 'agent_end', willRetry: false })).toBeNull();
    const failed = watcher.feed({ type: 'agent_settled', aborted: false });
    expect(failed?.outcome).toBe('error');
    expect(failed?.error).toBe('overloaded: retry later');
  });

  it('announces a truncation the run did not recover from', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'agent_end',
      messages: [reply('it was going well until', { stopReason: 'length' })],
    });
    const done = watcher.feed({ type: 'agent_settled', aborted: false });
    expect(done?.outcome).toBe('truncated');
    expect(done?.report).toBe('it was going well until');
  });

  it('keeps quiet about a failure the human caused by stopping the run', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'agent_end',
      messages: [
        reply('', { stopReason: 'error', errorMessage: 'aborted mid-request' }),
      ],
    });
    expect(watcher.feed({ type: 'agent_settled', aborted: true })).toBeNull();
  });

  it('forgets an announced report eventually, so a repeat can still be news', () => {
    const time = clock();
    const watcher = new RunWatcher(time.now);
    const final = reply('Done.');
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [final] })?.report).toBe(
      'Done.',
    );
    // The same answer re-issued inside the same run is not a new report.
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [final] })).toBeNull();
    // Nor is the next one an hour later, had `agent_settled` never arrived to clear the memory.
    time.advance(60 * 60_000);
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [final] })?.report).toBe(
      'Done.',
    );
  });

  it('reports each continuation of a run as its own report', () => {
    const watcher = new RunWatcher();
    feedRun(watcher, reply('first report'));
    // A queued follow-up or a post-run compaction restarts the loop with a fresh reply.
    watcher.feed({ type: 'agent_start' });
    const second = watcher.feed({
      type: 'agent_end',
      messages: [reply('second report')],
    });
    expect(second?.report).toBe('second report');
  });

  it('does not announce the same report twice in one run', () => {
    const watcher = new RunWatcher();
    const final = reply('Done — nothing further to do.');
    expect(feedRun(watcher, final)).toHaveLength(1);
    // A re-issued answer inside the same run is not a second report.
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [final] })).toBeNull();
    // The next run may say the same thing, and that is news again.
    watcher.feed({ type: 'agent_settled', aborted: false });
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [final] })?.report).toBe(
      'Done — nothing further to do.',
    );
  });

  it('ignores a run that produced no assistant message', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_end', messages: [] })).toBeNull();
    expect(watcher.feed({ type: 'agent_end' })).toBeNull();
  });

  it('collapses a multi-paragraph report into one line', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    const done = watcher.feed({
      type: 'agent_end',
      messages: [reply('summary:\n\n- one file changed\n- tests pass\n')],
    });
    expect(done?.report).toBe('summary: - one file changed - tests pass');
  });

  it('releases a failure when the child dies before it can settle', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'agent_end',
      messages: [
        reply('', { stopReason: 'error', errorMessage: 'child died' }),
      ],
    });
    // No `agent_settled` is coming: the runtime went down. The failure is all the run has to say.
    const dropped = watcher.abandon();
    expect(dropped?.outcome).toBe('error');
    expect(dropped?.error).toBe('child died');
    expect(watcher.abandon()).toBeNull();
  });

  it('does not carry a failure across a run boundary', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'agent_end',
      messages: [reply('', { stopReason: 'error', errorMessage: 'gone' })],
    });
    // The next run starts (a restart, or a fresh prompt) and never finishes an answer.
    watcher.feed({ type: 'agent_start' });
    expect(watcher.feed({ type: 'agent_settled', aborted: false })).toBeNull();
  });

  it('settles once', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({
      type: 'agent_end',
      messages: [reply('', { stopReason: 'error', errorMessage: 'gone' })],
    });
    expect(watcher.feed({ type: 'agent_settled' })?.outcome).toBe('error');
    expect(watcher.feed({ type: 'agent_settled' })).toBeNull();
  });

  it('passes over the events it does not care about', () => {
    const watcher = new RunWatcher();
    expect(watcher.feed({ type: 'message_update' } as RpcEvent)).toBeNull();
    expect(
      watcher.feed({
        type: 'tool_execution_end',
        toolCallId: 'a',
        toolName: 'bash',
      }),
    ).toBeNull();
    expect(watcher.feed({ type: 'agent_settled', aborted: false })).toBeNull();
  });

  it('takes a streamed message_end as the reply too', () => {
    const watcher = new RunWatcher();
    watcher.feed({ type: 'agent_start' });
    watcher.feed({ type: 'message_end', message: reply('streamed final') });
    const done = watcher.feed({ type: 'agent_end' });
    expect(done?.report).toBe('streamed final');
  });
});

describe('describeFinishedRun', () => {
  it('names the project and the outcome', () => {
    const message = describeFinishedRun(
      { outcome: 'done', report: 'Fixed it.', stopReason: 'stop' },
      'vsix-amulet2',
    );
    expect(message.title).toBe('vsix-amulet2: report ready');
    expect(message.body).toBe('Fixed it.');
    expect(message.critical).toBe(false);
  });

  it('says what failed instead of quoting an empty reply', () => {
    const message = describeFinishedRun(
      {
        outcome: 'error',
        report: '',
        error: '429 rate limited',
        stopReason: 'error',
      },
      'repo',
    );
    expect(message.title).toBe('repo: run failed');
    expect(message.body).toBe('429 rate limited');
  });

  it('marks a text-less reply as such', () => {
    const message = describeFinishedRun(
      { outcome: 'done', report: '', stopReason: 'stop' },
      'repo',
    );
    expect(message.body).toBe('(the reply had no text)');
  });
});
