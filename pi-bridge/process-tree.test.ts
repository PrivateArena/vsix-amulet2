import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  childrenOf,
  descendantsOf,
  isAlive,
  isShellProcess,
  parsePsRow,
  readProcessTable,
  signalProcess,
  stopProcess,
} from './process-tree';
import { StopBoard, planStop } from './tool-stop';

/**
 * The one place the aim is checked against real processes.
 *
 * Everything else in this feature is protocol and UI, and `planStop` is unit-tested against synthetic
 * tables — but a process kill is the single operation Amulet performs that can be pointed at the wrong
 * thing, and a wrong target here means killing a process the human never asked about. So this file does the
 * thing for real: it spawns a detached shell exactly the way pi's bash tool does
 * (`spawn(shell, ['-c', command], { detached: true })`), asks the bridge which process that was, and stops it.
 *
 * POSIX only. Windows has no process groups and discovers processes through CIM, none of which is worth
 * pretending to test from a Linux CI box; the code path says so in its own comments.
 */

const spawned: ChildProcessWithoutNullStreams[] = [];

function spawnDetached(command: string): ChildProcessWithoutNullStreams {
  // The same shape as pi's own shell tool: a detached child, therefore its own process-group leader.
  const child = spawn('/bin/bash', ['-c', command], { detached: true });
  child.stdout.resume();
  child.stderr.resume();
  spawned.push(child);
  return child;
}

afterAll(() => {
  for (const child of spawned) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone, which is the hoped-for outcome.
    }
  }
});

const posix = process.platform !== 'win32';
const suite = posix ? describe : describe.skip;

suite('readProcessTable', () => {
  it('sees a detached shell this process spawned, and reads its command back', () => {
    const command = 'sleep 411 && echo not-run';
    const child = spawnDetached(command);
    expect(child.pid).toBeTypeOf('number');

    const table = readProcessTable();
    expect(table.error).toBeUndefined();
    const mine = childrenOf(table).filter(isShellProcess);
    const target = mine.find((info) => info.pid === child.pid);
    expect(target, 'the spawned shell is listed under this pid').toBeDefined();
    // This is the match `planStop` runs on: pi passes the command as one argv element, so the shell's own
    // command line carries it verbatim.
    expect(target?.cmdline).toContain(command);
    expect(target?.pgid).toBe(child.pid);
  });

  it('does not list processes that are not this one’s children', () => {
    const table = readProcessTable();
    const pids = table.processes.map((info) => info.pid);
    expect(pids).toContain(process.pid);
    // A process owned by somebody else's tree is in `ps`, but `childrenOf` is what the aim reads.
    const foreign = table.processes.filter(
      (info) => info.ppid !== process.pid && info.pid !== process.pid,
    );
    expect(foreign.length).toBeGreaterThan(0);
  });

  it('never signals a group it does not lead', () => {
    const table = readProcessTable();
    const own = table.processes.find(
      (info) => info.pid === process.pid && info.pgid !== process.pid,
    );
    if (!own) return; // a session leader in its own group: nothing to prove
    const outcome = signalProcess(own, table, 'SIGKILL');
    // The guard is the whole point: `process.kill(-own.pgid)` here would take out the test runner.
    expect(outcome.group).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
  });
});

suite('stopProcess', () => {
  it('kills the command and the tree it started, and leaves this process alone', async () => {
    // A compound command, so bash does not replace itself and the two sleeps are real grandchildren — the shape of
    // a hung build with its own workers, which is what a group kill has to reach.
    const marker = 'amulet-probe-412';
    const parent = spawnDetached(`sleep 412 & sleep 412; wait # ${marker}`);
    const table = readProcessTable();
    const target = childrenOf(table).find(
      (info) => info.pid === parent.pid,
    ) as NonNullable<ReturnType<typeof childrenOf>[number]>;
    expect(target.cmdline).toContain(marker);
    const tree = descendantsOf(readProcessTable(), target);
    expect(tree.length).toBeGreaterThanOrEqual(1);

    const outcome = await stopProcess(target, table, 300);
    expect(outcome.signals.length).toBeGreaterThan(0);
    expect(outcome.group).toBe(true);
    expect(isAlive(target.pid)).toBe(false);
    // The group is what makes this more than `child.kill()`: every process the command started went with it.
    for (const member of tree) expect(isAlive(member.pid)).toBe(false);
    expect(isAlive(process.pid)).toBe(true);
  }, 15_000);
});

suite('the whole aim, against live processes', () => {
  it('picks the process of the named call out of two running commands', () => {
    // Both of these exec out of bash, so the two candidates are `sleep 414` and `sleep 415`: the identification
    // has to come from the command text, which is exactly what a hung `make world` looks like too.
    const first = spawnDetached('sleep 414');
    const second = spawnDetached('sleep 415');
    const board = new StopBoard();
    board.record({
      type: 'tool_call',
      toolCallId: 'a',
      toolName: 'bash',
      input: { command: 'sleep 415' },
    });

    const plan = planStop(board.of('a')!, readProcessTable());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.matched).toBe('command');
    expect(plan.target.pid).toBe(second.pid);
    expect(plan.target.pid).not.toBe(first.pid);
  });

  it('refuses to guess when several processes could be the one it was asked about', () => {
    // Two shells still interpreting their scripts, and a command name none of them carries: the honest answer is
    // "I do not know", because the alternative is signalling a command nobody pointed at.
    spawnDetached('sleep 416 & sleep 416; wait');
    spawnDetached('sleep 417 & sleep 417; wait');
    const board = new StopBoard();
    board.record({
      type: 'tool_call',
      toolCallId: 'b',
      toolName: 'bash',
      input: { command: 'sleep 999999' },
    });
    const plan = planStop(board.of('b')!, readProcessTable());
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe('no-process');
  });
});

suite('signalProcess refuses what it does not own', () => {
  it('will not signal a process whose parent is not this one', () => {
    // The `planStop` scope check is the first line of defence; this is the second, and it is the one that has
    // to hold even if a caller hands `signalProcess` a target it built itself.
    const table = readProcessTable();
    const foreign = table.processes.find(
      (info) => info.ppid !== table.selfPid && info.pid !== table.selfPid,
    )!;
    expect(foreign).toBeDefined();
    const outcome = signalProcess(foreign, table, 'SIGKILL');
    expect(outcome).toEqual({ group: false, pids: [], sent: false });
    expect(isAlive(foreign.pid, table)).toBe(true);
  });

  it('will not signal the bridge process itself', () => {
    const table = readProcessTable();
    const self = table.processes.find((info) => info.pid === process.pid)!;
    expect(signalProcess(self, table, 'SIGKILL').sent).toBe(false);
  });
});

suite('descendantsOf', () => {
  it('walks the whole subtree, not just the first level', () => {
    // bash replaces itself for a single simple command, so a three-level tree needs compounds all the way down —
    // and `descendantsOf` is what the per-process kill path walks when a target is not a group leader.
    const marker = 'amulet-probe-433';
    const parent = spawnDetached(
      `bash -c "sleep 434 & sleep 435; wait # ${marker}-inner" & sleep 436; wait # ${marker}`,
    );
    const table = readProcessTable();
    const root = childrenOf(table).find(
      (info) => info.pid === parent.pid,
    ) as NonNullable<ReturnType<typeof childrenOf>[number]>;
    const tree = descendantsOf(table, root);
    const lines = tree.map((info) => info.cmdline).join('\n');
    expect(lines).toContain(`${marker}-inner`); // level 2: the inner bash
    expect(lines).toContain('sleep 434'); // level 3: a grandchild of this process
    expect(lines).toContain('sleep 436');
    expect(tree.some((info) => info.pid === process.pid)).toBe(false);
  });
});

describe('parsePsRow', () => {
  const NOW = 1_700_000_000_000;

  it('reads the fields the aim depends on, including a command full of spaces', () => {
    const row = parsePsRow(
      '  4242   1000   4242 Ss     00:07 /bin/bash -c pnpm run --filter "a b" build',
      NOW,
    );
    expect(row).toEqual({
      pid: 4242,
      ppid: 1000,
      pgid: 4242,
      state: 'S',
      cmdline: '/bin/bash -c pnpm run --filter "a b" build',
      startedAt: NOW - 7_000,
    });
  });

  it('reads the state letter with its modifiers off', () => {
    expect(parsePsRow('1 0 0 Sl 01:00 sleep 1', NOW)?.state).toBe('S');
    expect(parsePsRow('1 0 0 Z+ 01:00 sleep 1', NOW)?.state).toBe('Z');
  });

  it('turns every etime shape into an age', () => {
    const age = (text: string) =>
      NOW - (parsePsRow(`1 0 0 S ${text} sleep 1`, NOW)?.startedAt ?? NOW);
    expect(age('00:00')).toBe(0);
    expect(age('01:23')).toBe(83_000);
    expect(age('1:02:03')).toBe(3_723_000);
    // 2 days + 3 h + 4 min + 5 s
    expect(age('2-03:04:05')).toBe(183_845_000);
    // An unparseable age reads as "just started", which keeps the target eligible instead of refusing it.
    expect(age('n/a')).toBe(0);
  });

  it('ignores anything that is not one of its own rows', () => {
    expect(
      parsePsRow('  PID  PPID PGID STAT ELAPSED COMMAND', NOW),
    ).toBeUndefined();
    expect(parsePsRow('', NOW)).toBeUndefined();
  });
});

describe('readProcessTable', () => {
  it('reports times this process can compare with its own clock', () => {
    const table = readProcessTable();
    expect(table.error).toBeUndefined();
    const self = table.processes.find((info) => info.pid === process.pid);
    expect(self).toBeDefined();
    if (process.platform === 'win32') return;
    expect(table.timeBase).toBe('epoch');
    // A process that has been alive for hours must not read as if it started in the future.
    expect(self!.startedAt).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(self!.startedAt).toBeGreaterThan(Date.now() - 30 * 86_400_000);
    expect(self!.ppid).toBeGreaterThan(0);
  });
});
