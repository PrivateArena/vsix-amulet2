// Bridge harness: drive `pi --mode rpc -e <bridge bundle>` exactly like the extension host does and
// print what the Amulet bridge answers, so the runtime contract can be checked without VS Code.
//
//   node scripts/bridge-probe.mjs                                      # hello + get_commands
//   node scripts/bridge-probe.mjs '{"op":"omit","handle":{"kind":"toolCall","toolCallId":"call_1"}}}'
//   node scripts/bridge-probe.mjs --session /tmp/s.jsonl '{"op":"revert","entryId":"…"}' --messages
//
// Every op is a `BridgeRequest` body; `reqId` and `v` are added here. With no op argument, a `hello`
// capability probe runs. Nothing here needs a model or an API key: an extension command is handled
// without a provider request, which is exactly why the bridge could be built on it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.PI_BIN || 'pi';
const bundle =
  process.env.BRIDGE_BUNDLE || join(root, 'dist/pi-bridge/amulet-bridge.mjs');
const cwd = process.env.PROBE_CWD || process.cwd();

const argv = process.argv.slice(2);
const sessionFlag = argv.includes('--session')
  ? argv[argv.indexOf('--session') + 1]
  : undefined;
const wantMessages = argv.includes('--messages');
const opArgs = argv.filter((a) => a.startsWith('{') || a.startsWith('/amulet'));

const spawnArgs = ['--mode', 'rpc'];
if (sessionFlag) spawnArgs.push('--session', sessionFlag);
if (process.env.BRIDGE_NO_E !== '1') spawnArgs.push('-e', bundle);

if (!existsSync(bundle)) {
  console.error(`bridge bundle missing: ${bundle} (run \`node esbuild.mjs\`)`);
  process.exit(1);
}

const child = spawn(binary, spawnArgs, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
let seq = 0;
const pending = new Map();

/** Resolve when the bridge answers the request id, or report that it never did. */
function callBridge(body) {
  const reqId = `probe-${++seq}`;
  const request = { v: 1, reqId, ...body };
  return new Promise((done) => {
    pending.set(reqId, done);
    send({
      id: `p${seq}`,
      type: 'prompt',
      message: `/amulet ${JSON.stringify(request)}`,
    });
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        done({ ok: false, error: 'no amulet:reply notify within 8s', reqId });
      }
    }, 8000);
  });
}

const rl = createInterface({ input: child.stdout });
const messageSnapshots = [];
rl.on('line', (line) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (obj.type === 'extension_ui_request' && obj.method === 'notify') {
    const text = String(obj.message ?? '');
    if (text.startsWith('amulet:reply ')) {
      const reply = JSON.parse(text.slice('amulet:reply '.length));
      const done = pending.get(reply.reqId);
      if (done) {
        pending.delete(reply.reqId);
        done(reply);
      } else {
        console.log('[reply for an unknown reqId]', text);
      }
      return;
    }
    console.log('[notify]', text.slice(0, 160));
    return;
  }
  if (obj.type === 'response' && obj.data?.commands) {
    const names = obj.data.commands
      .filter((c) => c.source === 'extension')
      .map((c) => c.name);
    console.log('[extension commands]', JSON.stringify(names));
    console.log('[/amulet registered]', names.includes('amulet'));
    return;
  }
  if (obj.type === 'response' && obj.data?.messages) {
    messageSnapshots.push(obj.data.messages);
    return;
  }
  if (obj.type === 'response' && !obj.success) {
    console.log('[error response]', JSON.stringify(obj).slice(0, 200));
  }
});
child.stderr.on('data', (d) => {
  const text = String(d).trim();
  if (text) console.log('[stderr]', text.slice(0, 300));
});

const READY_MS = 2500;
const STEP_MS = 700;

setTimeout(async () => {
  send({ id: 'cmds', type: 'get_commands' });
  const ops = opArgs.length ? opArgs : ['{"op":"hello"}'];
  for (const arg of ops) {
    await new Promise((r) => setTimeout(r, STEP_MS));
    let body;
    try {
      body = JSON.parse(
        arg.startsWith('/amulet') ? arg.slice('/amulet'.length).trim() : arg,
      );
      if (body.v) delete body.v;
      if (body.reqId) delete body.reqId;
    } catch (err) {
      console.log('[bad op]', String(err.message).slice(0, 120));
      continue;
    }
    const reply = await callBridge(body);
    console.log(`[reply ${body.op}]`, JSON.stringify(reply));
    if (wantMessages) send({ id: `m${seq}`, type: 'get_messages' });
  }
  await new Promise((r) => setTimeout(r, STEP_MS));
  if (messageSnapshots.length) {
    const messages = messageSnapshots.at(-1);
    console.log(`[get_messages] ${messages.length} messages`);
    for (const m of messages) {
      const kinds = Array.isArray(m.content)
        ? m.content.map((b) => b?.type).join(',')
        : typeof m.content;
      console.log(
        `  role=${m.role}${m.toolCallId ? ` toolCallId=${m.toolCallId}` : ''} ${kinds}`,
      );
    }
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}, READY_MS);
