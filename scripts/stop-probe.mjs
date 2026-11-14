#!/usr/bin/env node
// Stop harness: prove, against a real `pi --mode rpc` child and a real hung command, that stopping *one
// command* is not the same thing as aborting the turn.
//
//   node scripts/stop-probe.mjs                      # stop the command with no note
//   node scripts/stop-probe.mjs "the dev server is already on :3000"
//   STOP_DELAY=6 COMMAND='sleep 900' node scripts/stop-probe.mjs
//   NESTED=1 node scripts/stop-probe.mjs "that task is already done"   # a subagent's own command
//
// What it does: starts a child with the Amulet bridge, asks the model to run a command that cannot finish,
// waits for `tool_execution_start`, sends `/amulet {"op":"stop", …}` for that very call id, and then reports
// the four things that matter:
//
//   1. the bridge's ack, with the pid it signalled and how sure it was about the aim;
//   2. the tool result the model received, whose first line must be the "Stopped by user" sentence;
//   3. that the *run continued* — an `agent_end` whose reply is not an abort, which is the whole difference
//      from the composer's Stop button;
//   4. that the command's own process really died.
//
// Nothing here needs VS Code, and it answers pi-gate's dialogs itself (an "Allow once" click), so it can be
// run against any pi that has the bridge bundle built (`node esbuild.mjs`).
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.PI_BIN || 'pi';
const bundle =
  process.env.BRIDGE_BUNDLE || join(root, 'dist/pi-bridge/amulet-bridge.mjs');
const cwd = process.env.PROBE_CWD || process.cwd();
const command = process.env.COMMAND || 'sleep 900';
const note = process.argv[2] ?? process.env.STOP_NOTE ?? '';
const stopDelayMs = Number(process.env.STOP_DELAY || 4000);
const timeoutMs = Number(process.env.PROBE_TIMEOUT || 180_000);
/**
 * Stop a command a *subagent* made rather than one the main agent made. This is the case the feature exists
 * for — a child that spent its whole time budget on one hung command — and it is the case that needs the
 * nested id: the call has no session entry, only `<subagentCallId>/<n>`, but it really runs a process.
 */
const nested = process.env.NESTED === '1';

if (!existsSync(bundle)) {
  console.error(`bridge bundle missing: ${bundle} (run \`node esbuild.mjs\`)`);
  process.exit(1);
}

const child = spawn(binary, ['--mode', 'rpc', '-e', bundle], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

let seq = 0;
const pending = new Map();
const seen = { stopAck: null, toolResult: null, agentEnd: null, settled: null };

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
      if (!pending.has(reqId)) return;
      pending.delete(reqId);
      done({ ok: false, error: 'no amulet:reply notify within 20s', reqId });
    }, 20_000);
  });
}

const rl = createInterface({ input: child.stdout });
let stopSent = false;
let killedPid = 0;
let aimed = null;
let witness = [];

/**
 * Every process of the child whose command line carries the command, straight from the OS.
 *
 * This is what turns "a pid was signalled" into "the right pid was signalled": the ack names a process, and
 * only a witness taken before the kill can say it was the one the tool call started.
 */
function describeTarget(piPid, text) {
  try {
    return execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmdline: m[3] }))
      .filter((row) => row.cmdline.includes(text))
      .map((row) => ({ pid: row.pid, ofTheChild: row.ppid === piPid }));
  } catch {
    return 'ps unavailable';
  }
}

rl.on('line', (line) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (obj.type === 'extension_ui_request') {
    if (obj.method === 'notify') {
      const text = String(obj.message ?? '');
      if (!text.startsWith('amulet:reply ')) {
        console.log('[notify]', text.slice(0, 200));
        return;
      }
      const reply = JSON.parse(text.slice('amulet:reply '.length));
      const done = pending.get(reply.reqId);
      if (done) {
        pending.delete(reply.reqId);
        done(reply);
      }
      return;
    }
    // pi-gate parks the call on a dialog. Answer "Allow once" (or accept whatever else asks) so the probe is
    // testing the stop and not the gate.
    const options = Array.isArray(obj.options) ? obj.options : [];
    const pick =
      obj.method === 'select'
        ? (options.find((o) => /allow once/i.test(String(o))) ?? options[0])
        : undefined;
    console.log(
      `[ui ${obj.method}] ${String(obj.message).slice(0, 90)} → ${pick ?? 'cancelled'}`,
    );
    send({
      type: 'extension_ui_response',
      id: obj.id,
      ...(pick === undefined ? { cancelled: true } : { value: pick }),
    });
    return;
  }
  if (obj.type === 'tool_execution_start') {
    console.log(
      `[tool start] ${obj.toolName} ${obj.toolCallId} parent=${obj.parentToolCallId ?? '-'}`,
    );
    if (obj.toolName !== 'bash' || stopSent) return;
    // In nested mode the outer `subagent` call is not a bash call, so the first bash event is the child's. If it
    // is not, the probe is not testing the case it exists for, and must say so instead of passing anyway.
    if (nested && !obj.parentToolCallId) {
      seen.failed =
        'the subagent never ran a command, so the nested case was not exercised';
      finish();
      return;
    }
    stopSent = true;
    const toolCallId = obj.toolCallId;
    setTimeout(async () => {
      // The witness must be taken while the command still runs: afterwards the only evidence left is the ack,
      // and an ack that names a pid proves nothing about whether it was the *right* pid.
      witness = describeTarget(child.pid, command);
      console.log(
        `[probe] asking the bridge to stop ${toolCallId} (note: ${note || '<none>'}); carrying the command: ${JSON.stringify(witness)}`,
      );
      const reply = await callBridge({
        op: 'stop',
        handle: { kind: 'toolCall', toolCallId },
        content: note,
      });
      seen.stopAck = reply;
      console.log('[stop ack]', JSON.stringify(reply));
      const signalled = reply?.stop?.pids ?? [];
      // Who was signalled, and was it the command's process? `ofTheChild` is the property the ack claims.
      aimed = witness.map((row) => ({
        ...row,
        signalled: signalled.includes(row.pid),
      }));
      console.log(
        '[probe] processes carrying the command:',
        JSON.stringify(aimed),
      );
      killedPid = reply?.stop?.pids?.[0] ?? 0;
      setTimeout(() => {
        if (!killedPid) return;
        let alive = true;
        try {
          process.kill(killedPid, 0);
        } catch {
          alive = false;
        }
        console.log(`[pid ${killedPid}] alive=${alive} — expected false`);
      }, 1500);
    }, stopDelayMs);
    return;
  }
  if (obj.type === 'tool_execution_end') {
    const blocks = obj.result?.content ?? [];
    const text = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
    seen.toolResult = {
      isError: obj.isError,
      text,
      parent: obj.parentToolCallId,
    };
    // Every result is kept: in nested mode the note lands on the *child's* result while the last tool to end is
    // the outer `subagent` call, so reading only the newest one would report a false negative.
    seen.results = [...(seen.results ?? []), { isError: obj.isError, text }];
    console.log(
      `[tool end] isError=${obj.isError} first line=${JSON.stringify(text.split('\n')[0] ?? '')}`,
    );
    return;
  }
  if (obj.type === 'agent_end') {
    const message = obj.message ?? obj.event?.message;
    const text = Array.isArray(message?.content)
      ? message.content.map((b) => b?.text ?? `<${b?.type}>`).join(' ')
      : String(message?.content ?? '');
    seen.agentEnd = { willRetry: obj.willRetry, text };
    console.log(
      `[agent_end] willRetry=${obj.willRetry} reply=${JSON.stringify(text.slice(0, 200))}`,
    );
    return;
  }
  if (obj.type === 'agent_settled') {
    seen.settled = { aborted: obj.aborted };
    console.log(`[agent_settled] aborted=${obj.aborted}`);
    finish();
    return;
  }
  if (obj.type === 'response' && !obj.success) {
    console.log('[error response]', JSON.stringify(obj).slice(0, 300));
  }
});
child.stderr.on('data', (d) => {
  const text = String(d).trim();
  if (text) console.log('[stderr]', text.slice(0, 300));
});

function finish() {
  const verdict = [];
  const ack = seen.stopAck;
  verdict.push(`bridge acked: ${ack ? ack.ok === true : 'never answered'}`);
  verdict.push(
    `signalled pids: ${JSON.stringify(ack?.stop?.pids ?? [])} (${ack?.stop?.matched ?? 'n/a'})`,
  );
  const results = seen.results ?? [seen.toolResult].filter(Boolean);
  const annotated = results.filter((r) => /Stopped by user/.test(r.text));
  verdict.push(
    annotated.length
      ? `note reached the model: ${annotated
          .map((r) => JSON.stringify(r.text.split('\n')[0]))
          .join(', ')}`
      : `note reached the model: FALSE — heads were ${JSON.stringify(
          results.map((r) => (r.text ?? '').split('\n')[0]),
        )}`,
  );
  verdict.push(
    `run continued: ${seen.settled ? seen.settled.aborted !== true : 'never settled'}`,
  );
  const hit = Array.isArray(aimed) ? aimed : [];
  verdict.push(
    `aim was a process of the child running the command: ${hit.some((row) => row.ofTheChild)} ` +
      `(witnessed ${JSON.stringify(hit)})`,
  );
  if (seen.failed) verdict.push(`INCONCLUSIVE: ${seen.failed}`);
  console.log('\n=== verdict ===');
  for (const line of verdict) console.log(' -', line);
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}

const READY_MS = 2500;
setTimeout(() => {
  const prompt = nested
    ? `Use the subagent tool with role "explore" and the task: "Run the bash command \`${command}\` exactly once and report what it printed. Do not run any other command." `
    : `Run exactly this bash command and then tell me what it printed: ${command}. Do not run anything else, do not use a timeout argument. `;
  console.log(
    `[probe] ${nested ? 'delegating' : 'asking the model to run'}: ${command}`,
  );
  send({ id: 'p1', type: 'prompt', message: prompt });
}, READY_MS);

setTimeout(() => {
  console.log('[probe] timed out waiting for the run to settle');
  finish();
}, timeoutMs);
