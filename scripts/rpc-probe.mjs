// Debug harness: drive `pi --mode rpc` exactly like the extension host does and
// dump the raw wire events so protocol drift against the installed pi is visible.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const binary = process.env.PI_BIN || 'pi';
const cwd = process.env.PROBE_CWD || process.cwd();
const promptText = process.argv[2] || 'Reply with exactly: OK';
const logPath = process.env.PROBE_LOG || 'tmp/rpc-events.jsonl';

try {
  writeFileSync(logPath, '');
} catch {}
const lines = [];
const child = spawn(binary, ['--mode', 'rpc'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    console.log('[raw]', line.slice(0, 200));
    return;
  }
  lines.push(obj);
  appendFileSync(logPath, JSON.stringify(obj) + '\n');
  const kind = obj.type ?? '(response)';
  const msg = obj.message ?? obj.event?.message;
  let detail = '';
  if (msg) {
    detail = ` role=${msg.role} contentType=${Array.isArray(msg.content) ? 'array' : typeof msg.content}`;
    if (typeof msg.content === 'string')
      detail += ` value=${JSON.stringify(msg.content.slice(0, 60))}`;
    if (Array.isArray(msg.content))
      detail += ' blocks=' + msg.content.map((b) => b?.type).join(',');
  }
  if (obj.error) detail += ` error=${JSON.stringify(obj.error).slice(0, 120)}`;
  console.log(`[${lines.length}] ${kind}${detail}`);
});
child.stderr.on('data', (d) =>
  console.log('[stderr]', String(d).trim().slice(0, 300)),
);

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');

const extra = (process.env.PROBE_COMMANDS || '')
  .split(';')
  .filter(Boolean)
  .map((c) => JSON.parse(c));
setTimeout(() => {
  send({ id: 'p1', type: 'prompt', message: promptText });
  for (const [i, cmd] of extra.entries())
    setTimeout(() => send({ id: `c${i}`, ...cmd }), 3000 * (i + 1));
}, 1500);

const timeoutMs = Number(process.env.PROBE_TIMEOUT || 60000);
setTimeout(async () => {
  writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n'));
  console.log('[done] wrote', logPath, lines.length, 'events');
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}, timeoutMs);
