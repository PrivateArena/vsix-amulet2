/**
 * Raising Amulet's own window when one of its system notifications is clicked.
 *
 * Nothing here imports `vscode`. The reason this has to be done by the client at all: a freedesktop
 * notification server does not activate anything — `xfce4-notifyd` 0.9.7 was checked against the wire and
 * its entire click vocabulary is the `ActionInvoked(id, key)` signal, with no activation token in sight
 * (`--activation-token-fd` is accepted by libnotify and stays empty) and no `Capabilities` property to
 * probe. So the notification is posted with an action, a waiting process learns the key was chosen, and
 * somebody has to move the window — that somebody is `xdotool`.
 *
 * Two rules follow from the shape of an X11 session and both are load-bearing:
 *
 * - **The window belongs to an ancestor process, never to this one.** The extension host owns no X window
 *   (`xdotool search --pid <exthost>` is empty); the top-level is mapped by VS Code's main process, which
 *   is `VSCODE_PID` when VS Code exported it and otherwise the second or third parent. So the probe walks
 *   candidates and stops at the first one that resolves.
 * - **A raw search result is not a window.** `xdotool search --pid` also returns Electron's unmapped 10×10
 *   and 200×200 helper windows, and `windowactivate` would happily activate one of those. `--onlyvisible`
 *   is the filter, and where that finds nothing (an iconified window is unmapped too) the candidates are
 *   disambiguated by title before anything is touched — a button that raises the wrong window is worse
 *   than no button.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveBinaryPath } from '../runtime/bootstrap';

/** The X11 toolchain is optional; a machine without it just gets a notification. */
const XDOOTOOL = 'xdotool';

/** `search` answers in one round trip; `--sync` on the other hand waits for the window manager. */
const SEARCH_TIMEOUT_MS = 2_000;
const RAISE_TIMEOUT_MS = 3_000;

/** Stop probing a machine that has never given us a window, rather than spawning per alert. */
const MAX_PROBE_FAILURES = 3;

/** One argv-only command. Never a shell string: a window title is never parsed. */
export interface X11Command {
  command: string;
  args: string[];
}

export interface X11Result {
  /** `null` when the child was killed by a signal (including our own timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A candidate window and the title the window manager has for it. */
export interface WindowCandidate {
  wid: string;
  name: string;
}

export interface FocusOutcome {
  ok: boolean;
  /** What was tried, or why nothing was — this is what the log and the test command show. */
  why: string;
}

export interface WindowFocus {
  /**
   * The window to raise, resolved once and remembered. `undefined` means "do not offer a click": the
   * caller must then post the notification exactly as it did before, with no action at all.
   */
  target(wanted: string[]): Promise<string | undefined>;
  /** Raise the window {@link target} handed out. A failure forgets the cached window. */
  raise(wid: string): Promise<FocusOutcome>;
  /** What the channel would use, for the test command and the log. */
  describe(): string;
}

/**
 * The pids that could own a desktop window, most likely first: the VS Code main process, then this
 * process and its ancestors. {@link parentOf} returns `undefined` at the top of the chain, so a machine
 * where `VSCODE_PID` is missing or wrong (a remote session, a reparented host) still finds the owner.
 */
export function windowPids(o: {
  vscodePid?: string;
  pid: number;
  parentOf: (pid: number) => number | undefined;
  maxDepth?: number;
}): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (pid: number | undefined) => {
    if (pid && pid > 1 && !seen.has(pid)) {
      seen.add(pid);
      out.push(pid);
    }
  };
  push(Number(o.vscodePid));
  for (let i = 0, cur: number | undefined = o.pid; i < (o.maxDepth ?? 8); i++) {
    push(cur);
    cur = cur === undefined ? undefined : o.parentOf(cur);
  }
  return out;
}

/** The ids `xdotool search` printed — decimal, one per line; its warnings go to stderr. */
export function parseWindowIds(stdout: string): string[] {
  return stdout
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

/**
 * Which candidate is ours. An unnamed window can never win: those are Electron's helper windows. A title
 * naming one of this workspace's folders wins outright, which is what separates two VS Code windows that
 * share one main process (and therefore one `_NET_WM_PID`). With nothing to match on, a single window is
 * still unambiguous — several are not, and then we do nothing.
 */
export function pickWindow(
  candidates: WindowCandidate[],
  wanted: string[],
): FocusOutcome & { wid?: string } {
  const named = candidates.filter((c) => c.name.trim().length > 0);
  if (!named.length) {
    return { ok: false, why: 'no window with a title for this process' };
  }
  const keys = wanted.map((w) => w.toLowerCase()).filter((w) => w.length > 0);
  const hit = named.find((c) =>
    keys.some((k) => c.name.toLowerCase().includes(k)),
  );
  if (hit) return { ok: true, wid: hit.wid, why: `title "${hit.name}"` };
  if (named.length === 1) {
    return {
      ok: true,
      wid: named[0]!.wid,
      why: `only window: "${named[0]!.name}"`,
    };
  }
  return {
    ok: false,
    why: `${named.length} windows for this process and none is titled ${keys.join(' / ') || 'a known workspace'}`,
  };
}

/**
 * The parent of {@link pid}. `/proc` first — a click is not hot, but it is also not a place to spawn a
 * shell when a file read answers. The fields after the last `)` are the only safe split, because a
 * process name may contain spaces and parentheses.
 */
export function parentOfProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    return Number.isFinite(ppid) && ppid > 1 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Start an X11 tool; never rejects — a failure is an outcome, not an exception. */
export async function runX11Command(
  command: X11Command,
  timeoutMs: number,
): Promise<X11Result> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      // `DISPLAY` alone is not enough on a session-private xauth file: without `XAUTHORITY` the server
      // answers "Authorization required", which reads like a broken window manager.
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) =>
      resolve({ code: null, stdout, stderr: stderr || String(err) }),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export interface WindowFocusDeps {
  log(text: string): void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  /** PATH lookup; `null` means the tool is not installed here. */
  resolve?: (command: string) => string | null;
  parentOf?: (pid: number) => number | undefined;
  run?: (command: X11Command, timeoutMs: number) => Promise<X11Result>;
}

/** Whether this platform even has the freedesktop/X11 vocabulary this module speaks. */
export function isX11Platform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  const unix =
    platform === 'linux' ||
    platform === 'freebsd' ||
    platform === 'openbsd' ||
    platform === 'netbsd';
  // A Wayland-only session has no X window to raise; an XWayland one still has `DISPLAY`, and the probe
  // below is what decides whether the window is actually visible to it.
  return unix && !!env.DISPLAY;
}

/**
 * Build the window raiser. One instance per extension host: the window is a property of this process, so
 * the answer is found once and reused for every later alert.
 */
export function createWindowFocus(deps: WindowFocusDeps): WindowFocus {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const self = deps.pid ?? process.pid;
  const parentOf = deps.parentOf ?? parentOfProc;
  const run = deps.run ?? runX11Command;
  const resolve =
    deps.resolve ??
    ((command: string) => {
      const found = resolveBinaryPath(command);
      return found.resolved ? found.command : null;
    });
  const usable = isX11Platform(platform, env);
  /** Resolved `xdotool`, or `null` once it is known to be absent. */
  let tool: string | null | undefined;
  /** The window we raised last time — it does not move while we live. */
  let cached: string | undefined;
  let failures = 0;

  const resolvedTool = (): string | undefined => {
    if (!usable) return undefined;
    if (tool === null) return undefined;
    if (tool === undefined) {
      tool = resolve(XDOOTOOL);
      if (!tool) {
        deps.log(
          `[notify] no "${XDOOTOOL}" on PATH — a notification cannot raise a window.`,
        );
      }
    }
    return tool ?? undefined;
  };

  const search = async (pid: number, onlyVisible: boolean) => {
    const result = await run(
      {
        command: tool!,
        args: [
          'search',
          ...(onlyVisible ? ['--onlyvisible'] : []),
          '--pid',
          String(pid),
        ],
      },
      SEARCH_TIMEOUT_MS,
    );
    return parseWindowIds(result.stdout);
  };

  const nameOf = async (wid: string) => {
    const result = await run(
      { command: tool!, args: ['getwindowname', wid] },
      SEARCH_TIMEOUT_MS,
    );
    // A chained `search … getwindowname` prints ids, not names, so each candidate is asked on its own.
    return result.code === 0 ? result.stdout.trim() : '';
  };

  /** One pid's window, preferring the mapped one and only then looking at unmapped candidates by title. */
  const forPid = async (pid: number, wanted: string[]) => {
    const visible = await search(pid, true);
    if (visible.length === 1) {
      return {
        ok: true,
        wid: visible[0],
        why: `window ${visible[0]} of pid ${pid}`,
      };
    }
    const pool = visible.length
      ? visible
      : // Nothing mapped: the window is iconified, and the unfiltered list now contains Electron's
        // helper windows — so a title has to decide, which is what `pickWindow` insists on.
        await search(pid, false);
    if (!pool.length) return undefined;
    const named: WindowCandidate[] = [];
    for (const wid of pool) named.push({ wid, name: await nameOf(wid) });
    return pickWindow(named, wanted);
  };

  return {
    async target(wanted) {
      if (!usable || failures >= MAX_PROBE_FAILURES) return undefined;
      if (cached) return cached;
      if (!resolvedTool()) return undefined;
      const pids = windowPids({
        vscodePid: env.VSCODE_PID,
        pid: self,
        parentOf,
      });
      for (const pid of pids) {
        const found = await forPid(pid, wanted);
        if (found?.ok && found.wid) {
          failures = 0;
          cached = found.wid;
          deps.log(`[notify] click will raise ${found.wid} (${found.why}).`);
          return cached;
        }
      }
      failures++;
      deps.log(
        `[notify] no VS Code window found for pids ${pids.join(', ')} — notifications stay click-less.`,
      );
      return undefined;
    },

    async raise(wid) {
      const command = resolvedTool();
      if (!command) {
        return { ok: false, why: `${XDOOTOOL} is not available` };
      }
      const result = await run(
        { command, args: ['windowactivate', '--sync', wid] },
        RAISE_TIMEOUT_MS,
      );
      if (result.code === 0) return { ok: true, why: `activated ${wid}` };
      // A dead window (closed, or a workspace that moved) must not be reused: forget it so the next
      // alert re-probes, and say what the tool complained about.
      if (cached === wid) cached = undefined;
      return {
        ok: false,
        why: `xdotool exited ${result.code ?? 'signal'}: ${
          (result.stderr || result.stdout).trim().slice(0, 120) || 'no output'
        }`,
      };
    },

    describe() {
      if (!usable) return `no X11 session (platform ${platform})`;
      if (tool === null) return `${XDOOTOOL} is not installed`;
      if (tool === undefined) return `${XDOOTOOL} (not tried yet)`;
      return cached ? `${tool} → ${cached}` : tool;
    },
  };
}
