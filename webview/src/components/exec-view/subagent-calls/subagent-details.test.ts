import { describe, expect, it } from 'vitest';
import { oneLine } from '../tool-display';
import {
  cleanReport,
  isSubagentTool,
  readSubagentDetails,
  resolveSubagentCard,
  subagentHasLog,
  subagentMetaLine,
  subagentPrompt,
  subagentStatusOf,
} from './subagent-details';

describe('readSubagentDetails', () => {
  it('returns null for payloads that are not a subagent report', () => {
    expect(readSubagentDetails(undefined)).toBeNull();
    expect(readSubagentDetails({})).toBeNull();
    expect(readSubagentDetails({ output: 'hi' })).toBeNull();
    expect(readSubagentDetails('running')).toBeNull();
  });

  it('reads the progress heartbeat payload', () => {
    const view = readSubagentDetails({
      status: 'running',
      role: 'explore',
      displayName: 'Explore',
      turns: 2,
      toolCalls: 3,
      activity: 'bash',
      elapsedMs: 14863,
      task: 'Survey the directory',
      model: 'local/qwen (inherited)',
      pendant: { title: 'Explore', subtitle: 'Survey the directory' },
    });
    expect(view).toMatchObject({
      title: 'Explore',
      subtitle: 'Survey the directory',
      status: 'running',
      activity: 'bash',
      elapsedMs: 14863,
    });
  });

  it('reads the settled payload, including the report', () => {
    const view = readSubagentDetails({
      status: 'completed',
      exit: 'done',
      report: 'Two files.',
      tokens: '4.2k token',
      turns: 5,
      toolCalls: 6,
      childSessionId: '01a175a1',
      childSessionFile: '/tmp/child.jsonl',
    });
    expect(view).toMatchObject({
      exit: 'done',
      report: 'Two files.',
      tokens: '4.2k token',
      childSessionFile: '/tmp/child.jsonl',
    });
  });

  it('reads the live phase, the reasoning trail and both file paths', () => {
    const view = readSubagentDetails({
      status: 'running',
      role: 'explore',
      displayName: 'Explore',
      phase: 'finalReport',
      childSessionFile: '/home/u/.pi/agent/sessions/--p--/subagent/a.jsonl',
      turnLogFile: '/tmp/pi-subagent/a.jsonl',
      reasoning: {
        turns: [
          { turn: 1, text: 'First, look at the tree.' },
          { turn: 2, text: 'Now read the manifest.' },
        ],
        truncated: true,
      },
    });
    expect(view).toMatchObject({
      phase: 'finalReport',
      turnLogFile: '/tmp/pi-subagent/a.jsonl',
      reasoningTruncated: true,
    });
    expect(view?.reasoning).toEqual([
      { turn: 1, text: 'First, look at the tree.' },
      { turn: 2, text: 'Now read the manifest.' },
    ]);
  });

  it('drops a reasoning entry with no text, and a phase it does not know', () => {
    const view = readSubagentDetails({
      report: 'ok',
      phase: 'sleeping',
      reasoning: {
        turns: [
          { turn: 3, text: '  ' },
          { turn: 4, text: 'real' },
        ],
      },
    });
    expect(view?.phase).toBeUndefined();
    expect(view?.reasoning).toEqual([{ turn: 4, text: 'real' }]);
    // No trail at all is an absent field, not an empty list the card would have to explain.
    expect(readSubagentDetails({ report: 'ok' })?.reasoning).toBeUndefined();
  });

  it('ignores fields of the wrong type', () => {
    const view = readSubagentDetails({ report: 'ok', turns: '5', tokens: 12 });
    expect(view).toMatchObject({
      report: 'ok',
      turns: undefined,
      tokens: undefined,
    });
  });
});

describe('resolveSubagentCard', () => {
  it('falls back to the tool name while the arguments are still streaming', () => {
    const view = resolveSubagentCard('subagent', undefined, {
      role: 'explore',
      task: 'Read a\nthen b',
    });
    expect(view).toEqual({ subtitle: 'Read a then b' });
    expect(isSubagentTool('subagent')).toBe(true);
    expect(isSubagentTool('bash')).toBe(false);
  });

  it('is null for an ordinary tool with unrelated details', () => {
    expect(
      resolveSubagentCard('bash', { output: 'x' }, { command: 'ls' }),
    ).toBeNull();
  });
});

describe('subagentMetaLine', () => {
  it('counts turns and elapsed time while the child runs', () => {
    // What the child is *doing* is the status line's job; the meta line only counts.
    expect(
      subagentMetaLine({ title: 'Explore', turns: 2, activity: 'bash' }, true),
    ).toBe('Explore · 2 turns');
    expect(
      subagentMetaLine({ title: 'Explore', turns: 2, elapsedMs: 75_000 }, true),
    ).toBe('Explore · 2 turns · 1m 15s');
  });

  it('shows usage and model once it settles', () => {
    expect(
      subagentMetaLine(
        {
          title: 'Explore',
          exit: 'timeout',
          turns: 55,
          toolCalls: 92,
          tokens: '666k token',
          model: 'local/qwen',
        },
        false,
      ),
    ).toBe('Explore · 55 turns · 92 tool uses · 666k token · local/qwen');
  });

  it('says a human stopped it, which is not the same as a child that failed', () => {
    // The note itself is in the model-facing header, and `cleanReport` strips that out of the card's report —
    // so without this part a stopped run and a crashed one render identically.
    const stopped = {
      title: 'Explore',
      exit: 'aborted',
      turns: 6,
      toolCalls: 11,
      stoppedBy: 'Stopped by user with note: the build is already green',
    };
    expect(subagentMetaLine(stopped, false)).toBe(
      'Explore · stopped by you · 6 turns · 11 tool uses',
    );
    // While it runs there is nothing to have said: a stop has not landed until the run settled.
    expect(subagentMetaLine({ ...stopped, stoppedBy: undefined }, true)).toBe(
      'Explore · 6 turns',
    );
  });

  it('reads the stop reason off the details payload', () => {
    const details = readSubagentDetails({
      displayName: 'Explore',
      role: 'explore',
      status: 'stopped',
      exit: 'aborted',
      report: 'partial findings',
      stoppedBy:
        'Stopped by user: the subagent was stopped before it reported.',
    });
    expect(details?.stoppedBy).toContain('was stopped before it reported');
  });
});

describe('subagentStatusOf', () => {
  it('names the phase a running child is in', () => {
    expect(subagentStatusOf({ phase: 'thinking' }, true)).toEqual({
      text: 'Thinking…',
      tone: 'working',
    });
    expect(
      subagentStatusOf({ phase: 'calling', activity: 'bash' }, true),
    ).toEqual({ text: 'Calling bash…', tone: 'working' });
    expect(subagentStatusOf({ phase: 'writing' }, true)).toEqual({
      text: 'Writing…',
      tone: 'report',
    });
    expect(subagentStatusOf({ phase: 'finalReport' }, true)).toEqual({
      text: 'Writing the final report…',
      tone: 'report',
    });
  });

  it('falls back to the last reported tool on a runtime that sends no phase', () => {
    expect(subagentStatusOf({ activity: 'read' }, true)).toEqual({
      text: 'Calling read…',
      tone: 'working',
    });
    // `activity: 'thinking'` is what pi-subagent sends when no tool is in flight — never a tool name.
    expect(subagentStatusOf({ activity: 'thinking' }, true)).toEqual({
      text: 'Working…',
      tone: 'working',
    });
  });

  it('states a settled run in words, not in exit codes', () => {
    expect(subagentStatusOf({ exit: 'done' }, false)).toEqual({
      text: 'Done',
      tone: 'done',
    });
    expect(subagentStatusOf({ exit: 'maxTurns' }, false)).toEqual({
      text: 'Out of turns',
      tone: 'stopped',
    });
    expect(subagentStatusOf({ exit: 'error' }, false)).toEqual({
      text: 'Failed',
      tone: 'failed',
    });
    expect(subagentStatusOf({ status: 'completed' }, false)).toEqual({
      text: 'Done',
      tone: 'done',
    });
  });

  it('says nothing when the payload reports no state', () => {
    expect(subagentStatusOf({}, false)).toBeNull();
    expect(subagentStatusOf({ status: 'running' }, false)).toBeNull();
  });
});

describe('subagentHasLog', () => {
  it('is true when either file was reported', () => {
    expect(subagentHasLog({ childSessionFile: '/tmp/a.jsonl' })).toBe(true);
    expect(subagentHasLog({ turnLogFile: '/tmp/b.jsonl' })).toBe(true);
    // An older runtime reports neither until the run settles, so the control simply is not there.
    expect(subagentHasLog({})).toBe(false);
  });
});

describe('cleanReport', () => {
  it('strips the model-facing header block the subagent tool prepends', () => {
    const raw = [
      '[subagent explore · INCOMPLETE (timeout) · 55 turns · 92 tool calls · 666.4s]',
      'model: local/qwen (inherited)',
      'transcript: /tmp/child.jsonl',
      '',
      '## Findings',
      '',
      '- two files',
    ].join('\n');
    expect(cleanReport(raw)).toBe('## Findings\n\n- two files');
    expect(cleanReport('Plain report.')).toBe('Plain report.');
    expect(cleanReport('')).toBe('');
  });
});

describe('subagentPrompt', () => {
  it('returns the whole task, newlines and all, where the header fits one line', () => {
    const task =
      'Survey the directory.\n\nRead each file and report the sizes.';
    expect(subagentPrompt({ role: 'explore', task })).toBe(task);
    expect(oneLine(subagentPrompt({ role: 'explore', task }))).toBe(
      'Survey the directory. Read each file and report the sizes.',
    );
  });

  it('accepts the argument names a forked subagent tool uses', () => {
    expect(subagentPrompt({ prompt: 'do x' })).toBe('do x');
    expect(subagentPrompt({ message: 'do y' })).toBe('do y');
  });

  it('falls back to the runtime subtitle when the arguments are gone', () => {
    expect(subagentPrompt({}, { subtitle: 'Survey the directory' })).toBe(
      'Survey the directory',
    );
    expect(subagentPrompt(undefined, undefined)).toBe('');
    expect(subagentPrompt({ role: 'explore' })).toBe('');
  });
});
