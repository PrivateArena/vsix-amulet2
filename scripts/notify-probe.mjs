#!/usr/bin/env node
/**
 * Click-to-focus, end to end, without VS Code.
 *
 *   node scripts/notify-probe.mjs ["title" "body"]
 *
 * Drives the same chain `src/notify/` runs: resolve the window that a click should raise, post a
 * notification that carries the action, read the notification id off fd 3 as the delivery receipt, wait for
 * the click, then activate. Everything it decides is printed as it happens, so a surprising result is
 * debuggable — and unlike a unit test it exercises the real notifier, the real window manager and a real
 * human finger.
 *
 * It resolves the window from *this* process, so run it from the terminal whose window you want raised;
 * under VS Code the extension host resolves its own window the same way (`VSCODE_PID`, then parents).
 */

import { spawn } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';

const ID_FD = 3;
const action = { key: 'default', label: 'Open Amulet' };
const expireMs = Number(process.env.EXPIRE_MS ?? 20_000);

const say = (text) => console.log(text);

function parentOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    return Number.isFinite(ppid) && ppid > 1 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Same argv-only shape as `runX11Command`, same promise-never-throws contract. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c));
    child.stderr?.on('data', (c) => (stderr += c));
    child.on('error', (err) =>
      resolve({ code: null, stdout, stderr: String(err) }),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      accessSync(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---------------------------------------------------------------- the window
const xdotool = which('xdotool');
say(
  `xdotool          : ${xdotool ?? 'NOT INSTALLED — a click could not raise anything'}`,
);
say(
  `DISPLAY          : ${process.env.DISPLAY ?? '(unset — no X11 window to raise)'}`,
);
if (!xdotool || !process.env.DISPLAY) process.exit(2);

const pids = [];
for (const seed of [Number(process.env.VSCODE_PID), process.pid]) {
  for (let pid = seed, i = 0; pid > 1 && i < 8; i++) {
    if (!pids.includes(pid)) pids.push(pid);
    pid = parentOf(pid);
  }
}
say(`candidate pids   : ${pids.join(' → ')}`);

let wid;
for (const pid of pids) {
  const visible = await run(xdotool, [
    'search',
    '--onlyvisible',
    '--pid',
    String(pid),
  ]);
  const ids = visible.stdout.split(/\s+/).filter((s) => /^\d+$/.test(s));
  say(`  pid ${pid}: ${ids.length} mapped window(s) ${ids.join(' ')}`);
  if (ids.length >= 1) {
    const names = [];
    for (const id of ids) {
      const name = await run(xdotool, ['getwindowname', id]);
      names.push({ id, name: name.stdout.trim() });
    }
    say(`           ${JSON.stringify(names)}`);
    // The same rule as `pickWindow`: an unnamed window is Electron scaffolding, never the target.
    wid = (names.length === 1 ? names[0] : names.find((n) => n.name))?.id;
    if (wid) break;
  }
}
if (!wid) {
  say(
    'no window resolved — the real code would post the notification without a click action.',
  );
  process.exit(2);
}
say(`window to raise  : ${wid}`);

// ---------------------------------------------------------------- the banner
const [
  title = 'amulet: probe',
  body = 'Click this banner (or its button) to raise the window.',
] = process.argv.slice(2);
const argv = [
  '--app-name=Amulet',
  '--urgency=normal',
  `--expire-time=${expireMs}`,
  '--action',
  `${action.key}=${action.label}`,
  `--id-fd=${ID_FD}`,
  '--',
  title,
  body,
];
say(
  `argv             : notify-send ${argv.map((a) => JSON.stringify(a)).join(' ')}`,
);

const child = spawn('/usr/bin/notify-send', argv, {
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  shell: false,
});
let id = '';
let stdout = '';
child.stdio[ID_FD].on('data', (c) => (id += c));
child.stdout.on('data', (c) => (stdout += c));

// The receipt: an id means the server posted it, and it arrives long before the banner is gone.
for (let waited = 0; waited < 2000 && !/\d+\s*\n/.test(id); waited += 25) {
  await new Promise((r) => setTimeout(r, 25));
}
const posted = Number.parseInt(id.trim(), 10);
say(`notification id  : ${posted} ${posted > 0 ? '(posted)' : '(NOT posted)'}`);
if (posted <= 0) process.exit(1);

say(`waiting for a click, up to ${expireMs} ms …`);
const code = await new Promise((resolve) => child.on('close', resolve));
const key = stdout.trim();
say(`notifier exit    : ${code ?? 'signal'} · stdout ${JSON.stringify(key)}`);
if (!key) {
  say('nobody clicked: expired or dismissed — nothing to activate.');
  process.exit(0);
}
say(
  `action key       : ${key}${key === action.key ? ' ← our click action' : ''}`,
);
if (key !== action.key) process.exit(0);

const raised = await run(xdotool, ['windowactivate', '--sync', wid]);
say(
  `windowactivate   : rc ${raised.code ?? 'signal'}${raised.stderr.trim() ? ` · ${raised.stderr.trim()}` : ''}`,
);
process.exit(raised.code === 0 ? 0 : 1);
