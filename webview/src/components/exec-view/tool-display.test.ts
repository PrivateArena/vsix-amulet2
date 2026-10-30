import { describe, expect, it } from 'vitest';
import type { ToolExec } from '../../store';
import {
  childCalls,
  formatDuration,
  toolDuration,
  toolFullText,
  toolPreview,
  toolRowPreview,
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
