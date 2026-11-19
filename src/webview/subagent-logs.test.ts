import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_TRACKED_SUBAGENT_LOGS,
  SubagentLogIndex,
  isReadableLogfile,
  noteSubagentEventLogs,
  pickSubagentLog,
  readSubagentLogPaths,
} from './subagent-logs';

const TRANSCRIPT =
  '/home/u/.pi/agent/sessions/--proj--/subagent/2026-11-19T10-00-00-000_abc.jsonl';
const RUN_LOG = '/tmp/pi-subagent/2026-11-19T10-00-00-000_explore_abc.jsonl';

describe('readSubagentLogPaths', () => {
  it('reads the two paths a subagent reports', () => {
    expect(
      readSubagentLogPaths({
        childSessionFile: TRANSCRIPT,
        turnLogFile: RUN_LOG,
      }),
    ).toEqual({ transcript: TRANSCRIPT, log: RUN_LOG });
  });

  it('is undefined for anything that names no file', () => {
    expect(readSubagentLogPaths(undefined)).toBeUndefined();
    expect(readSubagentLogPaths(null)).toBeUndefined();
    expect(readSubagentLogPaths('running')).toBeUndefined();
    expect(
      readSubagentLogPaths({ status: 'running', turns: 3 }),
    ).toBeUndefined();
    // An empty string is not a path: some runtimes report a known-empty field.
    expect(readSubagentLogPaths({ childSessionFile: '  ' })).toBeUndefined();
  });
});

describe('pickSubagentLog', () => {
  it('opens the transcript, and the run log only when there is no transcript', () => {
    expect(pickSubagentLog({ transcript: TRANSCRIPT, log: RUN_LOG })).toBe(
      TRANSCRIPT,
    );
    expect(pickSubagentLog({ log: RUN_LOG })).toBe(RUN_LOG);
    expect(pickSubagentLog(undefined)).toBeUndefined();
  });
});

describe('SubagentLogIndex', () => {
  it('records the paths a call reported and merges a later, fuller payload', () => {
    const index = new SubagentLogIndex();
    // A progress update can name the run log before the transcript file exists.
    index.note('call-1', { turnLogFile: RUN_LOG });
    expect(index.pathsOf('call-1')).toEqual({ log: RUN_LOG });
    index.note('call-1', { childSessionFile: TRANSCRIPT });
    expect(index.pathsOf('call-1')).toEqual({
      transcript: TRANSCRIPT,
      log: RUN_LOG,
    });
  });

  it('stores nothing for an ordinary tool result', () => {
    const index = new SubagentLogIndex();
    index.note('bash-1', { output: 'ok' });
    expect(index.pathsOf('bash-1')).toBeUndefined();
  });

  it('seeds from the tool results of a history snapshot', () => {
    const index = new SubagentLogIndex();
    index.seed([
      { role: 'user', content: 'go' },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [],
        details: { childSessionFile: TRANSCRIPT },
      },
      // A row whose id is not a string is not a tool result, whatever the wire says.
      { role: 'toolResult', content: [] },
    ] as never);
    expect(index.pathsOf('call-1')?.transcript).toBe(TRANSCRIPT);
  });

  it('forgets every run when the session or the child changes', () => {
    const index = new SubagentLogIndex();
    index.note('call-1', { childSessionFile: TRANSCRIPT });
    index.clear();
    expect(index.pathsOf('call-1')).toBeUndefined();
  });

  it('drops the oldest run past its budget', () => {
    const index = new SubagentLogIndex();
    for (let i = 0; i <= MAX_TRACKED_SUBAGENT_LOGS; i++) {
      index.note(`call-${i}`, { childSessionFile: `${TRANSCRIPT}#${i}` });
    }
    expect(index.pathsOf('call-0')).toBeUndefined();
    expect(index.pathsOf(`call-${MAX_TRACKED_SUBAGENT_LOGS}`)).toBeDefined();
  });
});

describe('noteSubagentEventLogs', () => {
  it('reads a live progress payload and a settled result alike', () => {
    const index = new SubagentLogIndex();
    noteSubagentEventLogs(index, {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: { details: { childSessionFile: TRANSCRIPT } },
    });
    expect(index.pathsOf('call-1')?.transcript).toBe(TRANSCRIPT);
    noteSubagentEventLogs(index, {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: { details: { turnLogFile: RUN_LOG } },
    });
    expect(index.pathsOf('call-1')).toEqual({
      transcript: TRANSCRIPT,
      log: RUN_LOG,
    });
  });

  it('ignores events with no result payload at all', () => {
    const index = new SubagentLogIndex();
    noteSubagentEventLogs(index, {
      type: 'tool_execution_start',
      toolCallId: 'c',
    });
    noteSubagentEventLogs(index, { type: 'turn_end' });
    expect(index.pathsOf('c')).toBeUndefined();
  });
});

describe('isReadableLogfile', () => {
  it('refuses anything that is not a session file, and any path that is not there', () => {
    // Refused before the disk is touched: a payload that names `~/.ssh/id_rsa` is not opened to look at it.
    expect(isReadableLogfile('/tmp/pi-subagent/run.log')).toBe(false);
    expect(isReadableLogfile('/home/u/.ssh/config')).toBe(false);
    expect(isReadableLogfile('/tmp/definitely-not-here-41f.jsonl')).toBe(false);
  });

  it('accepts a transcript that exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amulet-subagent-logs-'));
    const file = path.join(dir, '2026-11-19T10-00-00-000_abc.jsonl');
    fs.writeFileSync(file, '{"type":"session"}\n');
    try {
      expect(isReadableLogfile(file)).toBe(true);
      // A directory is not a file, however it is named.
      expect(isReadableLogfile(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
