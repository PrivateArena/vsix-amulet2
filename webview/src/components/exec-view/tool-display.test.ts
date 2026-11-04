import { describe, expect, it } from 'vitest';
import type { ToolExec } from '../../store';
import {
  TIP_HEAD_CHARS,
  TIP_HEAD_LINES,
  TIP_TAIL_CHARS,
  TIP_TAIL_LINES,
  childCalls,
  countCallRows,
  formatDuration,
  readLineRange,
  summarize,
  tipHead,
  tipTail,
  toolDuration,
  toolFullText,
  toolPreview,
  toolRowPreview,
  toolTarget,
} from './tool-display';

describe('formatDuration', () => {
  it('formats the ranges a tool card actually shows', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('<1s');
    expect(formatDuration(640)).toBe('<1s');
    expect(formatDuration(2600)).toBe('2.6s');
    expect(formatDuration(13000)).toBe('13s');
    expect(formatDuration(59_600)).toBe('60s');
    expect(formatDuration(75_000)).toBe('1m 15s');
  });
});

describe('toolDuration', () => {
  const running = {
    toolCallId: 't1',
    toolName: 'bash',
    status: 'running',
    startedAt: 10_000,
  } satisfies ToolExec;

  it('counts up from the start event once the call passes a second', () => {
    // Nothing under a second, live or settled: a badge that flashes up for a fast
    // read and vanishes on completion is worse than none at all.
    expect(toolDuration(running, 10_600)).toBe('');
    expect(toolDuration(running, 23_000)).toBe('13s');
    expect(toolDuration(running, 75_000)).toBe('1m 5s');
    // Never negative, whatever the clock does between the event and the tick.
    expect(toolDuration(running, 9_000)).toBe('');
  });

  it("prefers the tool's own progress estimate, which a subagent reports", () => {
    expect(toolDuration(running, 10_600, 74_000)).toBe('1m 14s');
  });

  it("reports the runtime's measurement once the call settles", () => {
    expect(
      toolDuration({ ...running, status: 'done', durationMs: 75_000 }, 0),
    ).toBe('1m 15s');
    // A reloaded history has the duration and never had a start time.
    expect(
      toolDuration(
        {
          toolCallId: 't2',
          toolName: 'read',
          status: 'done',
          durationMs: 4200,
        },
        0,
      ),
    ).toBe('4.2s');
  });

  it('stays silent for a call that finished inside a second', () => {
    expect(toolDuration({ ...running, status: 'done', durationMs: 6 }, 0)).toBe(
      '',
    );
  });

  it('shows nothing for a call the runtime never reported on', () => {
    expect(toolDuration(undefined, Date.now())).toBe('');
    expect(
      toolDuration(
        { toolCallId: 't3', toolName: 'bash', status: 'running' },
        0,
      ),
    ).toBe('');
  });
});

describe('toolPreview / toolFullText', () => {
  it('collapses a multi-line command into one line for the row', () => {
    const args = { command: 'ls -la /tmp\n  | head -50' };
    expect(toolPreview('bash', args)).toBe('ls -la /tmp | head -50');
  });

  it('keeps the untruncated command for the tooltip', () => {
    const command = 'ls -la /tmp\nfind /tmp -maxdepth 3';
    expect(toolFullText('bash', { command })).toBe(command);
  });

  it('falls back to the argument object when a tool has no known key', () => {
    expect(
      toolFullText('gateway_send', { kind: 'ping', attempt: 2 }),
    ).toContain('"kind": "ping"');
    expect(toolPreview('gateway_send', { kind: 'ping' })).toBe('');
  });

  it('survives missing and non-object arguments', () => {
    expect(toolPreview('bash', undefined)).toBe('');
    expect(toolFullText('bash', null)).toBe('');
    expect(toolFullText('bash', 'plain string')).toBe('plain string');
  });

  it('names the omitted-arguments case for a truncated history record', () => {
    const tool = {
      toolCallId: 't1',
      toolName: 'bash',
      status: 'done',
      argsOmittedBytes: 40000,
    } satisfies ToolExec;
    expect(toolRowPreview(tool)).toBe('[arguments omitted, 40000 bytes]');
  });
});

describe('readLineRange / toolTarget', () => {
  it('names the window a partial read covers', () => {
    expect(readLineRange({ offset: 120, limit: 42 })).toBe(':120-161');
    // An offset with no count runs to the end of the file, a count with no offset starts at 1.
    expect(readLineRange({ offset: 7 })).toBe(':7');
    expect(readLineRange({ limit: 200 })).toBe(':1-200');
    expect(
      toolTarget('read', { path: 'a/watch_test.go', offset: 120, limit: 42 }),
    ).toBe('a/watch_test.go:120-161');
  });

  it('says nothing about a whole-file read or a malformed argument', () => {
    expect(readLineRange({})).toBe('');
    // A strict schema reports an omitted optional argument as `null`, not as line 0.
    expect(
      readLineRange({ path: 'a.md', offset: null, limit: undefined }),
    ).toBe('');
    expect(readLineRange({ offset: 'two', limit: 4 })).toBe('');
    // Accepts the numeric string a looser model writes.
    expect(readLineRange({ offset: '10', limit: '2' })).toBe(':10-11');
  });

  it('keeps the range out of the path itself', () => {
    // The path alone is what Copy hands out and what the code body reads a language from.
    const args = { path: '/a/watch_test.go', offset: 120, limit: 42 };
    expect(summarize('read', args)).toBe('/a/watch_test.go');
    expect(toolFullText('read', args)).toBe('/a/watch_test.go');
  });

  it('is the range on a nested-call row, and nothing on another tool', () => {
    expect(toolPreview('read', { path: 'a.md', offset: 3, limit: 8 })).toBe(
      'a.md:3-10',
    );
    expect(toolTarget('write', { path: 'a.md', offset: 3, limit: 8 })).toBe(
      'a.md',
    );
  });
});

describe('childCalls', () => {
  const parent = {
    toolCallId: 'p',
    toolName: 'subagent',
    status: 'running',
    childIds: ['p/2', 'p/1', 'p/missing'],
  } satisfies ToolExec;
  const tools: Record<string, ToolExec> = {
    p: parent,
    'p/1': { toolCallId: 'p/1', toolName: 'bash', status: 'done' },
    'p/2': { toolCallId: 'p/2', toolName: 'read', status: 'done' },
  };

  it("resolves children in the parent's recorded order and drops unknown ids", () => {
    expect(childCalls(parent, tools).map((t) => t.toolCallId)).toEqual([
      'p/2',
      'p/1',
    ]);
  });

  it('is empty without a parent, a map, or children', () => {
    expect(childCalls(undefined, tools)).toEqual([]);
    expect(childCalls(parent, undefined)).toEqual([]);
    expect(
      childCalls({ toolCallId: 'x', toolName: 'bash', status: 'done' }, tools),
    ).toEqual([]);
  });
});

describe('tipTail', () => {
  it('passes what fits the budget through untouched', () => {
    expect(tipTail('total 12\nprobe.log')).toBe('total 12\nprobe.log');
    expect(tipTail('x'.repeat(TIP_TAIL_CHARS))).toBe(
      'x'.repeat(TIP_TAIL_CHARS),
    );
  });

  it('keeps the last lines of a long output, and says what it dropped', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const out = tipTail(lines.join('\n'));
    expect(out.split('\n').slice(1)).toEqual(lines.slice(-TIP_TAIL_LINES));
    expect(out.startsWith('… ')).toBe(true);
    expect(out).toContain('earlier chars');
    expect(out).not.toContain('line 0\n');
  });

  it('cuts to the character budget when few lines hold a wall of text', () => {
    const text = 'a'.repeat(TIP_TAIL_CHARS * 3);
    const out = tipTail(text);
    expect(out).toHaveLength(
      TIP_TAIL_CHARS + `… ${TIP_TAIL_CHARS * 2} earlier chars …\n`.length,
    );
    expect(out.endsWith('a')).toBe(true);
  });
});

describe('tipHead', () => {
  it('keeps a short command whole and trims its whitespace', () => {
    expect(tipHead('  ls -la /tmp  ')).toBe('ls -la /tmp');
    expect(tipHead('a'.repeat(TIP_HEAD_CHARS))).toBe(
      'a'.repeat(TIP_HEAD_CHARS),
    );
  });

  it('cuts the end of a long prompt, never its start', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `step ${i}`);
    const out = tipHead(lines.join('\n'));
    expect(out.split('\n').slice(0, TIP_HEAD_LINES)).toEqual(
      lines.slice(0, TIP_HEAD_LINES),
    );
    expect(out).toContain('more chars');
    expect(out).not.toContain('step 39');
  });
});

describe('countCallRows', () => {
  const nested: Record<string, ToolExec> = {
    p: {
      toolCallId: 'p',
      toolName: 'subagent',
      status: 'running',
      childIds: ['p/1', 'p/2'],
    },
    'p/1': { toolCallId: 'p/1', toolName: 'bash', status: 'done' },
    'p/2': {
      toolCallId: 'p/2',
      toolName: 'subagent',
      status: 'running',
      childIds: ['p/2/1'],
    },
    'p/2/1': { toolCallId: 'p/2/1', toolName: 'read', status: 'done' },
  };

  it('counts the nested rows a list renders, not just its top level', () => {
    const calls = childCalls(nested.p, nested);
    expect(calls).toHaveLength(2);
    expect(countCallRows(calls, nested)).toBe(3);
  });

  it('is zero for an empty list', () => {
    expect(countCallRows([], nested)).toBe(0);
  });
});
