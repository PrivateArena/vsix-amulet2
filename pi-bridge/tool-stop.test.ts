import { describe, expect, it } from 'vitest';
import {
  LIVE_CALL_LIMIT,
  StopBoard,
  START_CLOCK_SLACK_MS,
  attachStopNote,
  describeStop,
  planStop,
  stopNoteText,
} from './tool-stop';
import type { OwnedProcess, ProcessTable } from './process-tree';
import type { LiveCall, ToolResultEvent } from './pi-extension-api';

// --------------------------------------------------------------------------- helpers

const SELF = 1000;

function proc(
  overrides: Partial<OwnedProcess> & { pid: number },
): OwnedProcess {
  return {
    ppid: SELF,
    // pi spawns its shells detached, so the shell leads its own process group.
    pgid: overrides.pid,
    cmdline: `bash -c ${overrides.pid}`,
    executable: 'bash',
    startedAt: 5_000,
    ...overrides,
  };
}

function table(processes: OwnedProcess[], error?: string): ProcessTable {
  return {
    platform: 'linux',
    selfPid: SELF,
    processes,
    timeBase: 'epoch',
    ...(error === undefined ? {} : { error }),
  };
}

/** The same table with no comparable clock — what a Windows CIM query gives. */
const noClock = (t: ProcessTable): ProcessTable => ({ ...t, timeBase: 'none' });

function call(overrides: Partial<LiveCall> = {}): LiveCall {
  return {
    toolCallId: 'call_1',
    toolName: 'bash',
    command: 'pnpm run build',
    startedAt: 5_000,
    ...overrides,
  };
}

/** The shell pi would have spawned for `command`, plus anything else on the machine. */
function shellFor(command: string, pid = 4242): OwnedProcess {
  return proc({ pid, cmdline: `/bin/bash -c ${command}` });
}

function resultOf(toolCallId: string, text: string): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    details: { truncation: undefined },
    structuredContent: { exit_code: 137 },
    isError: true,
  };
}

// --------------------------------------------------------------------------- the board

describe('StopBoard.record', () => {
  const board = () => new StopBoard();

  it('remembers a shell call by the id a stop request will name', () => {
    const b = board();
    b.record({
      type: 'tool_call',
      toolCallId: 'call_1/3',
      toolName: 'bash',
      input: { command: 'sleep 999' },
      parentToolCallId: 'call_1',
    });
    expect(b.of('call_1/3')).toMatchObject({
      toolName: 'bash',
      command: 'sleep 999',
      parentToolCallId: 'call_1',
    });
  });

  it('ignores every call with no process to signal', () => {
    const b = board();
    // Not a shell.
    b.record({
      type: 'tool_call',
      toolCallId: 'a',
      toolName: 'read',
      input: { path: 'x' },
    });
    // A shell whose command has not arrived / is blank.
    b.record({
      type: 'tool_call',
      toolCallId: 'b',
      toolName: 'bash',
      input: {},
    });
    b.record({
      type: 'tool_call',
      toolCallId: 'c',
      toolName: 'bash',
      input: { command: '  ' },
    });
    expect(b.liveCalls()).toEqual([]);
  });

  it('forgets a call that finished, because a stale entry is a wrong target', () => {
    const b = board();
    b.record({
      type: 'tool_call',
      toolCallId: 'a',
      toolName: 'bash',
      input: { command: 'ls' },
    });
    b.forget('a');
    expect(b.of('a')).toBeUndefined();
  });

  it('holds no record once its result has been seen', () => {
    // `amulet-bridge.ts` does this from its `tool_result` hook. Without it a finished call would stay stoppable
    // for the life of the child, and a stale `startedAt` *widens* the next aim instead of narrowing it.
    const b = board();
    b.record({
      type: 'tool_call',
      toolCallId: 'a',
      toolName: 'bash',
      input: { command: 'ls' },
    });
    b.forget('a');
    expect(b.of('a')).toBeUndefined();
    expect(b.liveCalls()).toEqual([]);
  });

  it('bounds the ledger instead of growing with the run', () => {
    const b = board();
    for (let i = 0; i < LIVE_CALL_LIMIT + 5; i++) {
      b.record({
        type: 'tool_call',
        toolCallId: `c${i}`,
        toolName: 'bash',
        input: { command: `echo ${i}` },
      });
    }
    expect(b.liveCalls()).toHaveLength(LIVE_CALL_LIMIT);
    expect(b.of('c0')).toBeUndefined();
    expect(b.of(`c${LIVE_CALL_LIMIT + 4}`)).toBeDefined();
  });
});

// --------------------------------------------------------------------------- the aim

describe('planStop', () => {
  it('aims at the shell whose command line carries the command', () => {
    const plan = planStop(
      call(),
      table([
        proc({ pid: 11, cmdline: 'node /usr/lib/something.js' }),
        shellFor('pnpm run build', 4242),
      ]),
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 4242 },
      matched: 'command',
    });
  });

  it('matches a multiline command against one line of argv', () => {
    const plan = planStop(
      call({ command: 'for f in *.ts; do\n  grep -q x "$f"\ndone' }),
      table([shellFor('for f in *.ts; do grep -q x "$f" done')]),
    );
    expect(plan).toMatchObject({ ok: true, matched: 'command' });
  });

  it('aims at the process bash became, not only at a shell', () => {
    // The common case and the one a shell filter loses: bash replaces itself for a single simple command, so a
    // hung `make world` is a process called `make`. pi still spawned it, and it is still its group's leader.
    const plan = planStop(
      call({ command: 'make world' }),
      table([
        { ...proc({ pid: 77 }), executable: 'make', cmdline: 'make world' },
      ]),
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 77 },
      matched: 'command',
    });
  });

  it('never aims at a process another tool call spawned', () => {
    // A long-running `serve` from an earlier call, and the hung `pnpm` of this one.
    const plan = planStop(
      call({ command: 'pnpm run build' }),
      table([
        shellFor('python -m http.server 8000', 700),
        shellFor('pnpm run build', 701),
      ]),
    );
    expect(plan).toMatchObject({ ok: true, target: { pid: 701 } });
  });

  it('refuses to guess between several shells when the command matches none of them', () => {
    const plan = planStop(
      call({ command: 'make world' }),
      table([shellFor('tail -f log', 1), shellFor('sleep 100', 2)]),
    );
    expect(plan).toMatchObject({
      ok: false,
      code: 'no-process',
    });
    expect((plan as { error: string }).error).toMatch(/Abort turn/);
  });

  it('falls back to the only shell it can see, and says so', () => {
    // Another extension rewrote `input.command` after this hook ran, so the recorded text is gone.
    const plan = planStop(
      call({ command: 'pnpm run build' }),
      table([
        proc({ pid: 5, cmdline: 'node helper.js', executable: 'node' }),
        shellFor('./rewritten-build.sh --ci', 99),
      ]),
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 99 },
      matched: 'single-shell',
    });
  });

  it('does not aim at a child that could not have run that command', () => {
    const plan = planStop(
      call({ command: 'make world' }),
      table([
        proc({ pid: 6, cmdline: 'git status --porcelain', executable: 'git' }),
      ]),
    );
    expect(plan).toMatchObject({ ok: false, code: 'no-process' });
  });

  it('ignores a shell that was already running when the call began', () => {
    const plan = planStop(
      call({ command: 'pnpm run build', startedAt: 100_000 }),
      table([
        shellFor('tail -f /dev/null', 1),
        proc({
          pid: 2,
          cmdline: '/bin/bash -c pnpm run build',
          startedAt: 100_500,
        }),
      ]),
    );
    expect(plan).toMatchObject({ ok: true, target: { pid: 2 }, candidates: 1 });
  });

  it('reports a process-table failure rather than aiming blind', () => {
    const plan = planStop(
      call(),
      table([shellFor('pnpm run build')], 'ps: not found'),
    );
    expect(plan).toMatchObject({ ok: false, code: 'unsupported' });
    expect((plan as { error: string }).error).toMatch(/ps: not found/);
  });

  it('has nothing to stop when the child is running no command at all', () => {
    const plan = planStop(call(), table([proc({ pid: 3, ppid: 3 })]));
    expect(plan).toMatchObject({ ok: false, code: 'no-process' });
  });

  it('refuses the fallback whenever more than one call is live', () => {
    // The dangerous shape, reachable without any extension rewriting arguments: pi runs a batch's calls
    // concurrently, the human stops call A, and A's text no longer matches (a prefix got prepended). B's shell is
    // the only shell in the child — and killing it would stop the wrong command.
    const onePlausibleProcess = table([
      shellFor('pnpm run build', 60),
      proc({ pid: 61, cmdline: 'node helper.js', executable: 'node' }),
    ]);
    const plan = planStop(
      call({ toolCallId: 'a', command: 'make world' }),
      onePlausibleProcess,
      2,
    );
    expect(plan).toMatchObject({ ok: false, code: 'no-process' });
    expect((plan as { error: string }).error).toMatch(/2 calls are running/);
    // The same aim, with nothing else running, is the one case the fallback was written for.
    expect(
      planStop(
        call({ toolCallId: 'a', command: 'make world' }),
        table([shellFor('pnpm run build', 60)]),
        1,
      ),
    ).toMatchObject({ ok: true, matched: 'single-shell' });
  });

  it('still identifies by text when several calls are live', () => {
    // Only the fallback needs the single-call rule: a process carrying the command's own text is the call.
    const plan = planStop(
      call({ toolCallId: 'a', command: 'pnpm run build' }),
      table([shellFor('pnpm run build', 61), shellFor('tail -f log', 62)]),
      2,
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 61 },
      matched: 'command',
    });
  });

  it('reports how many processes and calls the aim chose between', () => {
    const plan = planStop(
      call({ command: 'sleep 1000' }),
      table([shellFor('sleep 1000', 20), shellFor('sleep 1000', 21)]),
      2,
    );
    expect(plan).toMatchObject({ ok: true, candidates: 2, liveCalls: 2 });
  });

  it('picks the oldest of two identical commands', () => {
    const plan = planStop(
      call({ command: 'sleep 1000' }),
      table([
        shellFor('sleep 1000', 20),
        proc({ pid: 21, cmdline: '/bin/bash -c sleep 1000', startedAt: 1 }),
      ]),
    );
    // startedAt 1 is the older one; the slack makes 5_000 eligible too, so the tie-break is age.
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 21 },
      candidates: 2,
    });
  });

  it('refuses to reach for a shell that predates the call', () => {
    // The clock sources differ (a `ps` start time is an estimate), so the slack is real — but once every
    // shell is older than the call by more than the slack, none of them can be it.
    const plan = planStop(
      call({ command: 'pnpm run build', startedAt: 900_000 }),
      table([shellFor('pnpm run build', 30)]),
    );
    expect(plan).toMatchObject({ ok: false, code: 'no-process' });
    expect(START_CLOCK_SLACK_MS).toBeGreaterThan(0);
  });

  it('still aims by the command when the platform cannot say how old anything is', () => {
    // Windows CIM reports no creation date. Refusing here would take the feature away from a whole
    // platform over a tie-breaker, while the command text alone already identifies the shell.
    const plan = planStop(
      call({ command: 'pnpm run build', startedAt: 900_000 }),
      noClock(
        table([shellFor('pnpm run build', 30), shellFor('tail -f x', 31)]),
      ),
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { pid: 30 },
      matched: 'command',
    });
  });
});

// --------------------------------------------------------------------------- the note

describe('stop note', () => {
  it('uses pi-gate’s vocabulary when there is a note', () => {
    expect(stopNoteText('the dev server is already running on :3000')).toBe(
      'Stopped by user with note: the dev server is already running on :3000',
    );
  });

  it('still says what happened when the human pressed Enter on an empty note', () => {
    expect(stopNoteText('')).toContain('Stopped by user');
    expect(stopNoteText('')).not.toContain('with note');
  });

  it('goes at the head of the result the model reads, and keeps everything else', () => {
    const board = new StopBoard();
    board.promiseNote('call_1', 'stop it, the port is taken');
    const rewritten = attachStopNote(
      resultOf('call_1', '…partial output…'),
      board,
    );
    expect(
      rewritten?.content?.map((block) => (block as { text?: string }).text),
    ).toEqual([
      'Stopped by user with note: stop it, the port is taken',
      '…partial output…',
    ]);
    expect(rewritten?.isError).toBe(true);
    // Replacing content without restating these would silently lose the exit code and the streamed tail.
    expect(rewritten?.structuredContent).toEqual({ exit_code: 137 });
    expect(rewritten?.details).toEqual({ truncation: undefined });
  });

  it('is handed over exactly once', () => {
    const board = new StopBoard();
    board.promiseNote('call_1', 'once');
    expect(attachStopNote(resultOf('call_1', 'x'), board)).toBeDefined();
    expect(attachStopNote(resultOf('call_1', 'x'), board)).toBeUndefined();
  });

  it('never touches a call nobody stopped', () => {
    const board = new StopBoard();
    board.promiseNote('other', 'not yours');
    expect(attachStopNote(resultOf('call_1', 'x'), board)).toBeUndefined();
  });
});

describe('describeStop', () => {
  it('says which signal and how sure the aim was', () => {
    expect(
      describeStop('command', {
        pids: [4242],
        group: true,
        signals: ['SIGTERM', 'SIGKILL'],
      }),
    ).toBe('SIGTERM then SIGKILL process group 4242 (matched the command)');
    expect(
      describeStop('single-shell', { pids: [7], group: false, signals: [] }),
    ).toBe(
      'already gone process 7 (was the only command this child was running)',
    );
  });
});
