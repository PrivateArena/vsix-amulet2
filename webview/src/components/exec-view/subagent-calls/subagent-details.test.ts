import { describe, expect, it } from 'vitest';
import {
  cleanReport,
  isSubagentTool,
  readSubagentDetails,
  resolveSubagentCard,
  subagentMetaLine,
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
  it('shows live activity while the child runs', () => {
    expect(
      subagentMetaLine({ title: 'Explore', turns: 2, activity: 'bash' }, true),
    ).toBe('Explore · 2 turns · calling bash');
  });

  it('shows outcome, usage and model once it settles', () => {
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
    ).toBe(
      'Explore · timeout · 55 turns · 92 tool uses · 666k token · local/qwen',
    );
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
