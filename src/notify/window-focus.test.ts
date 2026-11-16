import { describe, expect, it, vi } from 'vitest';
import {
  createWindowFocus,
  isX11Platform,
  parseWindowIds,
  pickWindow,
  runX11Command,
  windowPids,
  type X11Command,
  type X11Result,
} from './window-focus';

const ok = (stdout: string): X11Result => ({ code: 0, stdout, stderr: '' });
const miss = (): X11Result => ({
  code: 1,
  stdout: '',
  stderr: 'No window found',
});

describe('windowPids', () => {
  it('asks the main process first, then walks the chain', () => {
    expect(
      windowPids({
        vscodePid: '100',
        pid: 10,
        parentOf: (p) => (p === 10 ? 11 : p === 11 ? 100 : undefined),
      }),
    ).toEqual([100, 10, 11]);
  });

  it('tolerates a missing or bogus VSCODE_PID and never loops', () => {
    expect(
      windowPids({ vscodePid: 'not-a-pid', pid: 7, parentOf: () => 7 }),
    ).toEqual([7]);
    expect(windowPids({ pid: 7, parentOf: () => undefined })).toEqual([7]);
  });

  it('stops at init: a pid of 1 or 0 can own nothing', () => {
    expect(
      windowPids({ pid: 5, parentOf: (p) => (p === 5 ? 1 : undefined) }),
    ).toEqual([5]);
  });
});

describe('parseWindowIds', () => {
  it('keeps the ids and drops anything else the tool printed', () => {
    expect(parseWindowIds('50331649\n48234500\n')).toEqual([
      '50331649',
      '48234500',
    ]);
    expect(
      parseWindowIds('Defaulting to search window name\n48234500\n\n'),
    ).toEqual(['48234500']);
  });
});

describe('pickWindow', () => {
  it('prefers the window whose title names this workspace', () => {
    const picked = pickWindow(
      [
        { wid: '1', name: 'Other Repo - Visual Studio Code' },
        { wid: '2', name: 'Amulet - vsix-amulet2 - Visual Studio Code' },
      ],
      ['vsix-amulet2'],
    );
    expect(picked.wid).toBe('2');
  });

  it('never picks Electron’s unnamed helper windows', () => {
    const picked = pickWindow(
      [
        { wid: '1', name: '   ' },
        { wid: '2', name: '' },
      ],
      ['vsix-amulet2'],
    );
    expect(picked.ok).toBe(false);
    expect(picked.wid).toBeUndefined();
  });

  it('takes an unambiguous single window even when the title says nothing of ours', () => {
    expect(
      pickWindow(
        [{ wid: '7', name: 'Untrusted - Visual Studio Code' }],
        ['other-repo'],
      ).wid,
    ).toBe('7');
  });

  it('refuses to guess between several windows it cannot tell apart', () => {
    const picked = pickWindow(
      [
        { wid: '1', name: 'A - Visual Studio Code' },
        { wid: '2', name: 'B - Visual Studio Code' },
      ],
      ['zzz'],
    );
    expect(picked.ok).toBe(false);
    expect(picked.wid).toBeUndefined();
    expect(picked.why).toContain('2 windows');
  });
});

describe('isX11Platform', () => {
  it('needs a unix platform and a DISPLAY', () => {
    expect(isX11Platform('linux', { DISPLAY: ':0' })).toBe(true);
    expect(isX11Platform('freebsd', { DISPLAY: ':0' })).toBe(true);
    expect(isX11Platform('linux', {})).toBe(false);
    expect(isX11Platform('win32', { DISPLAY: ':0' })).toBe(false);
    expect(isX11Platform('darwin', { DISPLAY: ':0' })).toBe(false);
  });
});

/** A fake `xdotool`: `table` maps the argv tail to a result, in call order. */
function harness(
  table: Record<string, X11Result | X11Result[]>,
  o: { pid?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const calls: X11Command[] = [];
  const logs: string[] = [];
  const used = new Map<string, number>();
  const focus = createWindowFocus({
    log: (text) => logs.push(text),
    platform: 'linux',
    env: { DISPLAY: ':0.0', ...o.env },
    pid: o.pid ?? 10,
    resolve: (command) => `/usr/bin/${command}`,
    // This process's parent chain is not the fixture's; pretend we are a direct child of init, so the
    // candidate list is exactly `[VSCODE_PID, pid]`.
    parentOf: () => undefined,
    run: async (command: X11Command): Promise<X11Result> => {
      calls.push(command);
      const key = command.args.join(' ');
      const hit = table[key];
      if (hit === undefined) return miss();
      if (Array.isArray(hit)) {
        const i = used.get(key) ?? 0;
        used.set(key, i + 1);
        return hit[Math.min(i, hit.length - 1)]!;
      }
      return hit;
    },
  });
  return { focus, calls, logs };
}

describe('createWindowFocus', () => {
  it('resolves the window of VSCODE_PID and caches it', async () => {
    const { focus, calls } = harness(
      { 'search --onlyvisible --pid 1694928': ok('48234500\n') },
      { env: { VSCODE_PID: '1694928' } },
    );
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('48234500');
    expect(calls[0]?.command).toBe('/usr/bin/xdotool');
    // One spawn, and the options come before the command — xdotool rejects them after it.
    expect(calls.map((c) => c.args)).toEqual([
      ['search', '--onlyvisible', '--pid', '1694928'],
    ]);
    // Cached: a second alert costs nothing.
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('48234500');
    expect(calls).toHaveLength(1);
    expect(focus.describe()).toContain('48234500');
  });

  it('walks to the ancestors when VSCODE_PID owns no window', async () => {
    const { focus, calls } = harness(
      { 'search --onlyvisible --pid 10': ok('48234500\n') },
      { pid: 10, env: { VSCODE_PID: '999' } },
    );
    await expect(focus.target(['x'])).resolves.toBe('48234500');
    // Each pid is asked twice — the mapped search, then the unfiltered one — before moving on.
    expect(calls.map((c) => c.args.at(-1))).toEqual(['999', '999', '10']);
  });

  it('disambiguates several windows by title', async () => {
    const { focus, calls } = harness({
      'search --onlyvisible --pid 10': ok('111\n222\n'),
      'getwindowname 111': ok('Other Repo - Visual Studio Code\n'),
      'getwindowname 222': ok('Amulet - vsix-amulet2 - Visual Studio Code\n'),
    });
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('222');
    expect(calls.filter((c) => c.args[0] === 'getwindowname')).toHaveLength(2);
  });

  it('looks at unmapped windows by title when nothing is visible', async () => {
    // An iconified window is unmapped, and the unfiltered list is full of helper windows — so the title
    // is the only thing that may decide, and a helper window has none.
    const { focus } = harness({
      'search --pid 10': ok('50331649\n50331651\n48234500\n'),
      'getwindowname 50331649': ok('\n'),
      'getwindowname 50331651': ok('\n'),
      'getwindowname 48234500': ok(
        'Amulet - vsix-amulet2 - Visual Studio Code\n',
      ),
    });
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('48234500');
  });

  it('posts nothing clickable when it cannot find a window, and stops probing', async () => {
    const { focus, calls, logs } = harness({});
    for (let i = 0; i < 6; i++) {
      await expect(focus.target(['x'])).resolves.toBeUndefined();
    }
    // Three probes, each one the visible search plus the unfiltered one, then silence: a session without
    // a findable window is not re-probed for every finished run.
    expect(calls).toHaveLength(6);
    expect(logs.join(' ')).toContain('click-less');
  });

  it('raises with windowactivate --sync, and forgets a window that is gone', async () => {
    // One id the whole time, so a per-call response picks between "alive" and "closed".
    let alive = true;
    const focus = createWindowFocus({
      log: () => {},
      platform: 'linux',
      env: { DISPLAY: ':0', VSCODE_PID: '1694928' },
      resolve: (c) => `/usr/bin/${c}`,
      parentOf: () => undefined,
      run: async (command: X11Command): Promise<X11Result> => {
        if (command.args[0] === 'windowactivate') {
          return alive ? ok('') : miss();
        }
        return ok('48234500\n');
      },
    });
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('48234500');
    await expect(focus.raise('48234500')).resolves.toMatchObject({
      ok: true,
      why: 'activated 48234500',
    });

    // The window was closed while the alert waited: the raise fails, and a dead id must not be kept.
    alive = false;
    const outcome = await focus.raise('48234500');
    expect(outcome.ok).toBe(false);
    expect(outcome.why).toContain('No window found');
    alive = true;
    await expect(focus.target(['vsix-amulet2'])).resolves.toBe('48234500');
  });

  it('reports an activation failure instead of pretending', async () => {
    const focus = createWindowFocus({
      log: () => {},
      platform: 'linux',
      env: { DISPLAY: ':0' },
      resolve: (c) => `/usr/bin/${c}`,
      run: async (): Promise<X11Result> => ({
        code: 1,
        stdout: '',
        stderr: 'window: is not found\n',
      }),
    });
    const outcome = await focus.raise('123');
    expect(outcome.ok).toBe(false);
    expect(outcome.why).toContain('is not found');
  });

  it('offers nothing without xdotool, and says why', async () => {
    const run = vi.fn(async (): Promise<X11Result> => miss());
    const noTool = createWindowFocus({
      log: () => {},
      platform: 'linux',
      env: { DISPLAY: ':0' },
      resolve: (): null => null,
      run,
    });
    await expect(noTool.target(['x'])).resolves.toBeUndefined();
    expect(noTool.describe()).toContain('not installed');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('runX11Command', () => {
  it('runs a real tool and reports its output and exit code', async () => {
    const result = await runX11Command(
      { command: process.execPath, args: ['-e', 'process.stdout.write("hi")'] },
      5_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hi');
  });

  it('reports a command that cannot be started, without rejecting', async () => {
    const result = await runX11Command(
      { command: '/nonexistent/amulet-xdotool', args: ['search'] },
      5_000,
    );
    expect(result.code).toBeNull();
    expect(result.stderr).not.toBe('');
  });
});
