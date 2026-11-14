/**
 * Seeing (and stopping) the processes this child owns.
 *
 * Why this file exists: pi exposes no per-tool cancellation. `ExecuteToolOptions` is `{signal, onUpdate}`
 * and the signal a model-issued call gets is *the run's*, so `abort` is the only lever pi gives a client —
 * and pulling it ends the whole turn, which is what Amulet's Stop button has always done. There is,
 * however, a second lever that needs no API at all: pi's shell tools
 * (`dist/core/tools/bash.js`) `spawn(shell, [...args, command], { detached: process.platform !== 'win32' })`,
 * so the command runs in a process the *bridge can see and signal* — the same detached child pi itself kills
 * with `killProcessTree` (`dist/utils/shell.js`) when a run aborts. Signalling that one child is how a single
 * hung command is stopped while the run, the conversation and every sibling call survive.
 *
 * Rules, all of them load-bearing:
 *  - **Only ever a process pi spawned.** Every candidate's parent is `selfPid`; pi's own pid, its own process
 *    group and anything above it are refused by construction (`signalProcess` re-checks).
 *  - **A group kill requires a group leader.** Because `detached: true` makes the shell its own group leader,
 *    `-pid` is exactly the tree of that one command. If some platform or shell config breaks that assumption,
 *    `group` stays false and only the observed tree is killed — killing pi's own group would kill the editor's
 *    runtime, which is not a mistake to leave reachable.
 *  - **The reader is pure I/O.** Deciding *which* process a tool call refers to is `tool-stop.ts`'s business;
 *    this file only produces a table and sends signals, so the aim can be unit-tested without a process.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** One OS process, reduced to what identifying a tool call's shell needs. */
export interface OwnedProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** The argv joined by single spaces — for a pi shell tool, `<shell> -c <the whole command>`. */
  cmdline: string;
  /** Lower-cased basename of argv[0], with `.exe` dropped: `bash`, `pwsh`, `node`. */
  executable: string;
  /** The kernel's state letter (`R`, `S`, `D`, `T`, `Z`, …) where the platform reports one. */
  state?: string;
  /**
   * When the process began, as `epoch` milliseconds when the platform allows it to be known at all.
   *
   * Only ever compared against another number from the same table, or against the `Date.now()` a `tool_call`
   * hook recorded — which is exactly why {@link ProcessTable.timeBase} has to say what these are.
   */
  startedAt: number;
}

/** What `readProcessTable` saw, plus why it may have seen nothing. */
export interface ProcessTable {
  platform: NodeJS.Platform;
  /** The process the bridge runs in, which is pi's own child and every shell tool's parent. */
  selfPid: number;
  processes: OwnedProcess[];
  /**
   * What the `startedAt` values here mean, because the aim compares one of them to a `Date.now()` from a hook.
   *
   * `epoch` says they are wall-clock milliseconds, so "did this process begin as late as that call?" is a
   * question they can answer. `none` says they are a platform's own count (or nothing at all, which is what a
   * Windows CIM query without a date column gives) and comparing those to an epoch would make every real target
   * look impossibly old — the failure mode that refuses to stop the command the human is pointing at.
   */
  timeBase: 'epoch' | 'none';
  /** Why the table is empty/unreadable, in the sentence the human gets. Undefined = usable. */
  error?: string;
}

/** Binaries pi uses as a shell for a `bash`/`powershell` call — and anything else worth stopping. */
const SHELL_EXECUTABLES = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'ksh',
  'fish',
  'nu',
  'pwsh',
  'powershell',
  'cmd',
]);

export function isShellProcess(info: OwnedProcess): boolean {
  return SHELL_EXECUTABLES.has(info.executable);
}

/** Whether `pid` is a process a signal could still reach. A not-yet-reaped child is not. */
export function isAlive(pid: number, table?: ProcessTable): boolean {
  if (pid <= 0) return false;
  // The table already carries the state letter, so a caller that has one must not ask the OS again: this file
  // runs inside the process that is streaming the run, and every `ps` it spawns is a syscall budget spent.
  const known = table?.processes.find((info) => info.pid === pid);
  if (known) return known.state !== 'Z';
  const state = processState(pid);
  if (state !== undefined) return state !== 'Z';
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The kernel's state letter for one process, or undefined when this platform cannot say.
 *
 * Needed because a shell pi spawned is *pi's own child*, and an exited child stays a zombie until its parent
 * waits for it: `process.kill(pid, 0)` answers "alive" about a process that is nothing but a task struct. Without
 * this, a command that obeyed SIGTERM would still be sent SIGKILL and reported as if it had refused.
 */
function processState(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      const rest = stat
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      return rest[0]?.[0];
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'win32') return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return out ? out[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Read the table on the current platform. Never throws: an unreadable table is an answer, not a crash. */
export function readProcessTable(
  selfPid = process.pid,
  platform: NodeJS.Platform = process.platform,
): ProcessTable {
  try {
    const read =
      platform === 'win32' ? readWindowsProcesses : readPosixProcesses;
    return { platform, selfPid, ...read(platform) };
  } catch (err) {
    return {
      platform,
      selfPid,
      processes: [],
      timeBase: 'none',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** pi's direct children — the shells its tool calls spawned, and nothing else. */
export function childrenOf(table: ProcessTable): OwnedProcess[] {
  return table.processes.filter((info) => info.ppid === table.selfPid);
}

/** The whole subtree under `root`, in the order the table listed it. */
export function descendantsOf(
  table: ProcessTable,
  root: OwnedProcess,
): OwnedProcess[] {
  const byParent = new Map<number, OwnedProcess[]>();
  for (const info of table.processes) {
    const list = byParent.get(info.ppid);
    if (list) list.push(info);
    else byParent.set(info.ppid, [info]);
  }
  const out: OwnedProcess[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop() as OwnedProcess;
    for (const child of byParent.get(current.pid) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

export interface SignalOutcome {
  /** Whether a process *group* was signalled (POSIX, and only for a group leader). */
  group: boolean;
  /** Every pid the operation covered — the group leader, or the tree that was walked instead. */
  pids: number[];
  /** Whether at least one signal left. False means the process was already gone. */
  sent: boolean;
}

/**
 * Send `signal` to one observed process.
 *
 * A group leader (which is how pi spawns its shells) is killed as a group, exactly the way pi's own
 * `killProcessTree` does, so a command's whole tree goes — including a build that spawned its own workers.
 * Anything else is killed process by process, walking the subtree this table can see, which is the honest
 * fallback rather than the intended path: it is only reached when the target is not a group leader, and a
 * group kill of a group pi itself leads would take the runtime down with the command.
 */
export function signalProcess(
  target: OwnedProcess,
  table: ProcessTable,
  signal: NodeJS.Signals,
): SignalOutcome {
  // The ownership test, re-asserted here rather than trusted from `planStop`: this is the line where a pid
  // becomes a signal, so it has to hold on its own. A process that is not a child of the bridge's own process
  // is somebody else's, and pi's own group is never a candidate.
  if (
    target.pid <= 0 ||
    target.pid === table.selfPid ||
    target.ppid !== table.selfPid
  ) {
    return { group: false, pids: [], sent: false };
  }
  const group = table.platform !== 'win32' && target.pgid === target.pid;
  if (group) {
    try {
      process.kill(-target.pid, signal);
      return { group: true, pids: [target.pid], sent: true };
    } catch {
      // ESRCH (already dead) or EPERM (not ours): fall through to the per-process path.
    }
  }
  const tree = [target, ...descendantsOf(table, target)];
  const pids: number[] = [];
  let sent = false;
  for (const info of tree) {
    if (info.pid === table.selfPid) continue;
    pids.push(info.pid);
    try {
      process.kill(info.pid, signal);
      sent = true;
    } catch {
      // Already gone: still a process this stop covered, and the ack lists what it aimed at.
    }
  }
  return { group: false, pids, sent };
}

/** What one stop did, in the terms `ToolStopEvidence` reports. */
export interface StopOutcome {
  group: boolean;
  pids: number[];
  signals: string[];
}

/**
 * Stop one command: ask first, then insist, and *verify* instead of assuming.
 *
 * SIGTERM lets a well-behaved program flush and exit; pi's own abort path goes straight to SIGKILL, which is
 * right for a run that is being thrown away and wrong for a command a human just decided to end. Either way
 * the tool call comes back non-zero (`128 + signal`) and the run continues, which is the whole point: the model
 * reads an end to that call, not an end to its turn.
 *
 * Three rules make this more than "send a signal and hope":
 *  - **the group decides, not the leader.** A leader that obeyed SIGTERM can leave a worker that installed its
 *    own handler — the hung build with its own toolchain, which is the shape this feature exists for — so
 *    liveness is answered over every process in the target's group.
 *  - **the table is re-read before escalating.** The grace window is 1.5 s of a moving world and pids are
 *    recycled; SIGKILL only leaves once the target is *still* a child of this process running *still* the
 *    same command.
 *  - **Windows is not polite.** There `process.kill` is `TerminateProcess`, so the TERM-then-KILL dance would
 *    report a courtesy that never happened: one SIGKILL, one honest signal in the ack.
 */
export async function stopProcess(
  target: OwnedProcess,
  table: ProcessTable,
  graceMs = STOP_TERM_GRACE_MS,
): Promise<StopOutcome> {
  if (table.platform === 'win32') {
    const only = signalProcess(target, table, 'SIGKILL');
    return {
      group: false,
      pids: only.pids,
      signals: only.sent ? ['SIGKILL'] : [],
    };
  }
  const first = signalProcess(target, table, 'SIGTERM');
  const signals = first.sent ? ['SIGTERM'] : [];
  if (graceMs > 0) await sleep(graceMs);
  // Fresh eyes on a world that moved while the command was being asked politely.
  const now = readProcessTable(table.selfPid, table.platform);
  const current = now.processes.find((info) => info.pid === target.pid);
  // A zombie's argv is empty, so an unreadable command line cannot contradict the plan — and a zombie is not
  // alive, so the escalation below will not fire on its account.
  const stillTheSameCommand =
    current !== undefined &&
    current.ppid === now.selfPid &&
    (current.cmdline === '' || current.cmdline === target.cmdline);
  const members = now.processes.filter(
    (info) => info.pgid === target.pgid && info.pid !== now.selfPid,
  );
  const survived =
    stillTheSameCommand && members.some((info) => isAlive(info.pid, now));
  if (!survived) {
    // The group is gone — obeyed, or already dead. Nothing may be reached for, and no SIGKILL may be claimed.
    return { group: first.group, pids: first.pids, signals };
  }
  const second = signalProcess(current as OwnedProcess, now, 'SIGKILL');
  return {
    group: second.group || first.group,
    pids: second.pids.length ? second.pids : first.pids,
    signals: second.sent ? [...signals, 'SIGKILL'] : signals,
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** How long a command gets to notice it was stopped before it is killed outright. */
export const STOP_TERM_GRACE_MS = 1500;

// --------------------------------------------------------------------------- readers

/**
 * POSIX: one `ps`, which is the same call on every flavour and the only one worth making here.
 *
 * The alternative — walking `/proc` from JavaScript — opens two files per process on the machine, thousands of
 * syscalls, synchronously, in the process that is streaming a model response and servicing the RPC pipe. `ps`
 * asks the kernel for the same table in one pass and is also the only way to see the *grandchildren*, which the
 * group-liveness check needs. `/proc` survives as the fallback for a system without `ps` (some containers), and
 * it is the more accurate of the two where it runs: `etime` has a one-second resolution.
 */
function readPosixProcesses(platform: NodeJS.Platform): ProcessRead {
  try {
    const viaPs = readPsProcesses();
    if (viaPs.processes.length) return viaPs;
  } catch {
    // No `ps` on PATH (or it refused): fall through to the kernel files.
  }
  if (platform === 'linux') {
    const fromProc = readLinuxProcesses();
    if (fromProc) return fromProc;
  }
  throw new Error('neither `ps` nor /proc could be read');
}

/**
 * `starttime` as wall clock: boot epoch + ticks since boot.
 *
 * `btime` comes from `/proc/stat`, and a 100 Hz USER_HZ is the kernel's constant on every Linux port that
 * matters here. The assumption is not load-bearing: a wrong scale puts the *real* target outside the slack, and
 * the answer then is a refusal the human can read rather than a kill of something else. No `btime`, no epoch
 * base — the table goes to the `none` time base and the aim falls back to the command text.
 */
const LINUX_TICK_MS = 10;

function bootEpochMs(): number | undefined {
  try {
    const match = /^btime (\d+)/m.exec(readFileSync('/proc/stat', 'utf8'));
    return match ? Number(match[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** What a reader produced: the rows, and whether their times are comparable to `Date.now()`. */
interface ProcessRead {
  processes: OwnedProcess[];
  timeBase: 'epoch' | 'none';
}

function readLinuxProcesses(): ProcessRead | undefined {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return undefined;
  }
  const boot = bootEpochMs();
  const out: OwnedProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue;
    }
    const fields = parseProcStat(stat);
    if (!fields) continue;
    let argv: string[] = [];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean);
    } catch {
      // A kernel thread, or one that just exited.
    }
    out.push({
      pid,
      ppid: fields.ppid,
      pgid: fields.pgid,
      state: fields.state,
      cmdline: argv.join(' '),
      executable: executableOf(argv[0]),
      startedAt:
        boot === undefined
          ? 0
          : boot + (Number(fields.starttime) || 0) * LINUX_TICK_MS,
    });
  }
  return { processes: out, timeBase: boot === undefined ? 'none' : 'epoch' };
}

/** `pid (comm) state ppid pgrp …` — and `comm` may contain spaces and parentheses. */
function parseProcStat(
  text: string,
):
  { ppid: number; pgid: number; state: string; starttime: string } | undefined {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (`state`), so field N lives at index N-3.
  if (rest.length < 20) return undefined;
  const ppid = Number(rest[1]);
  const pgid = Number(rest[2]);
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid)) return undefined;
  return { ppid, pgid, state: rest[0] ?? '', starttime: rest[19] ?? '0' };
}

/**
 * Every process, one line each: pid, parent, group, state, age, command.
 *
 * `-A` selects all of them, `-ww` stops `ps` truncating the command (which would break the text match the aim
 * depends on), and the `=` on each header suppresses the title line. `stat` is the process *state* set
 * (`S`, `Sl`, `Z+`); its first character is what `isAlive` reads.
 */
function readPsProcesses(): ProcessRead {
  const out = execFileSync(
    'ps',
    ['-Aww', '-o', 'pid=,ppid=,pgid=,stat=,etime=,command='],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const now = Date.now();
  const rows: OwnedProcess[] = [];
  for (const line of out.split('\n')) {
    const row = parsePsRow(line, now);
    if (!row) continue;
    rows.push({
      ...row,
      executable: executableOf(row.cmdline.split(/\s+/)[0]),
    });
  }
  return { processes: rows, timeBase: 'epoch' };
}

/**
 * One `ps` line, in the field order {@link readPsProcesses} asked for.
 *
 * Exported for the tests: on macOS and BSD this is the only reader there is, and its shape is exactly the kind
 * of thing that breaks silently — a command full of spaces, a state letter with a modifier (`Sl`, `Z+`), an age
 * that has rolled past midnight.
 */
export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  cmdline: string;
  startedAt: number;
}

export function parsePsRow(line: string, now = Date.now()): PsRow | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    state: (match[4] ?? '')[0] ?? '',
    cmdline: (match[6] ?? '').trim(),
    // `etime` is how long it has been alive, so subtracting it from now orders the table correctly.
    startedAt: now - elapsedMs(match[5] ?? ''),
  };
}

/** `[[DD-]hh:]mm:ss` → milliseconds. Unparseable means "assume young", which only affects a tie-break. */
function elapsedMs(text: string): number {
  const day = /(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!day) return 0;
  const [, d, h, m, s] = day;
  return (
    (Number(d ?? 0) * 86400 +
      Number(h ?? 0) * 3600 +
      Number(m ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  );
}

/**
 * Windows: there is no `/proc` and no process group to signal, so one CIM query for the tree and
 * `taskkill /T` for the kill (`signalProcess` walks the subtree here).
 */
function readWindowsProcesses(): ProcessRead {
  const script =
    'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CommandLine ' +
    '| ConvertTo-Json -Compress';
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  const trimmed = out.trim();
  if (!trimmed) return { processes: [], timeBase: 'none' };
  const parsed = JSON.parse(
    trimmed.startsWith('[') ? trimmed : `[${trimmed}]`,
  ) as Array<{
    ProcessId?: number;
    ParentProcessId?: number;
    CommandLine?: string | null;
  }>;
  return {
    processes: parsed
      .filter((row) => typeof row.ProcessId === 'number')
      .map((row) => {
        const cmdline = (row.CommandLine ?? '').trim();
        const argv = cmdline.split(/\s+/).filter(Boolean);
        return {
          pid: Number(row.ProcessId),
          ppid: Number(row.ParentProcessId ?? 0),
          // No group semantics on Windows; anything but the pid, so a group kill is never attempted.
          pgid: Number(row.ProcessId) + 1,
          cmdline,
          executable: executableOf(argv[0]),
          startedAt: 0,
        };
      }),
    // No creation date in the query, so ages are unknown and the aim uses the command text alone.
    timeBase: 'none',
  };
}

function executableOf(argv0: string | undefined): string {
  if (!argv0) return '';
  const name = basename(argv0.replace(/\\/g, '/')).toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}
