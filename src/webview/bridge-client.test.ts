import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_COMMAND_NAME,
  buildBridgeRequest,
  encodeBridgeReply,
  parseBridgeRequestArgs,
  type BridgeCapabilities,
  type BridgeReply,
  type BridgeRequest,
} from '../../shared/bridge-protocol';
import type { Logger, PiRuntime } from '../runtime/pi-runtime';
import { BRIDGE_ACK_TIMEOUT_MS, BridgeClient } from './bridge-client';

/**
 * The ack correlation of the Amulet bridge, tested without VS Code and without a child process: what
 * matters is which `reqId` a client claims, what it puts on the wire, and what it does when nothing
 * answers.
 */

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  show: () => {},
};

interface Sent {
  text: string;
  images: unknown;
  options: unknown;
}

interface Stub {
  runtime: PiRuntime | null;
  /** Every prompt the client sent, in order. */
  sent: Sent[];
  /** Every text the client asked {@link PiRuntime.isExtensionCommand} about. */
  probed: string[];
}

/** A runtime that reports the bridge command as loaded and never answers by itself. */
function stubRuntime(
  options: {
    /** False stands in for a pi that never loaded the bridge. */
    loaded?: boolean;
    /** What the `prompt` response says — a real command answers `handled`. */
    disposition?: unknown;
  } = {},
): Stub {
  const sent: Sent[] = [];
  const probed: string[] = [];
  const commands = new Set(
    options.loaded === false ? [] : [BRIDGE_COMMAND_NAME],
  );
  const runtime = {
    isExtensionCommand(text: string) {
      probed.push(text);
      const space = text.indexOf(' ');
      return commands.has(space < 0 ? text.slice(1) : text.slice(1, space));
    },
    prompt(text: string, images?: unknown, opts?: unknown): Promise<unknown> {
      sent.push({ text, images, options: opts });
      return Promise.resolve(options.disposition ?? 'handled');
    },
  };
  return { runtime: runtime as unknown as PiRuntime, sent, probed };
}

const clientOf = (stub: Stub): BridgeClient =>
  new BridgeClient(() => stub.runtime, logger);

/** Drain the microtasks a queued `prompt` needs, with no time passing. */
const flushed = () => vi.advanceTimersByTimeAsync(0);

/** The request the client actually put on the wire — where a test reads the `reqId` back. */
function sentRequest(sent: Sent[], index = 0): BridgeRequest {
  const parsed = parseBridgeRequestArgs(sent[index].text);
  if ('error' in parsed) {
    throw new Error(
      `the sent payload is not a bridge request: ${parsed.error}`,
    );
  }
  return parsed;
}

const ackOf = (request: BridgeRequest): string =>
  encodeBridgeReply({ v: 1, reqId: request.reqId, op: request.op, ok: true });

const capabilities: BridgeCapabilities = {
  contextEdit: true,
  navigateTree: true,
  piVersion: '1.5.0',
};

const omitInit: Omit<BridgeRequest, 'v' | 'reqId' | 'op'> = {
  handle: { kind: 'toolCall', toolCallId: 'call_read_1' },
};

/** The private pending map: the leak and double-apply assertions look at the real state. */
const pendingOf = (client: BridgeClient): Map<string, unknown> =>
  (client as unknown as { pending: Map<string, unknown> }).pending;

describe('BridgeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the runtime whether the command is loaded, by the protocol name', async () => {
    const stub = stubRuntime();
    expect(clientOf(stub).isAvailable()).toBe(true);
    // The name comes from the protocol, never from a literal of this file.
    expect(stub.probed).toEqual([`/${BRIDGE_COMMAND_NAME}`]);
    expect(clientOf(stubRuntime({ loaded: false })).isAvailable()).toBe(false);
    // No runtime at all (a surface that never connected) is simply not available.
    expect(new BridgeClient(() => null, logger).isAvailable()).toBe(false);
  });

  it('sends the op as a `/amulet` prompt with the long response budget', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    const call = client.call('omit', omitInit);
    await flushed();

    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].text.startsWith(`/${BRIDGE_COMMAND_NAME} `)).toBe(true);
    const request = sentRequest(stub.sent);
    expect(request.op).toBe('omit');
    expect(request.handle).toEqual(omitInit.handle);
    // The 3rd argument is the 15-minute budget: an extension command's response only lands when its
    // handler returns, so the default one fails a command that worked.
    expect(stub.sent[0].options).toEqual({ longRunning: true });
    expect(stub.sent[0].images).toBeUndefined();

    expect(client.handleNotify(ackOf(request))).toBe(true);
    await expect(call).resolves.toMatchObject({
      ok: true,
      reqId: request.reqId,
    });
    expect(pendingOf(client).size).toBe(0);
  });

  it('resolves the call and consumes only a notify whose reqId it owns', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    const call = client.call('omit', omitInit);
    await flushed();
    const request = sentRequest(stub.sent);

    // Some other extension's toast, and a reply for a call this client never made.
    expect(client.handleNotify('pi-gate: allowed `npm test`')).toBe(false);
    expect(
      client.handleNotify(
        encodeBridgeReply({
          ...buildBridgeRequest('other-req-1', 'omit'),
          ok: true,
        }),
      ),
    ).toBe(false);
    // Malformed ack text is not ours either.
    expect(client.handleNotify('amulet:reply {not json')).toBe(false);
    expect(pendingOf(client).size).toBe(1);

    expect(client.handleNotify(ackOf(request))).toBe(true);
    await expect(call).resolves.toMatchObject({ ok: true });
    // Consumed: the same notify again belongs to nobody.
    expect(client.handleNotify(ackOf(request))).toBe(false);
    expect(pendingOf(client).size).toBe(0);
  });

  it('reports a missing ack as a bridge error and forgets the call', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    const call = client.call('revert', { entryId: 'e7', summarize: false });
    await flushed();

    let settled = false;
    void call.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(BRIDGE_ACK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(pendingOf(client).size).toBe(1);

    await vi.advanceTimersByTimeAsync(2);
    const reply = await call;
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('expected an error reply');
    expect(reply.code).toBe('busy');
    expect(reply.error).toContain('revert');
    expect(pendingOf(client).size).toBe(0);

    // And the ack that lands afterwards must not be applied: that caller already reported a failure.
    expect(client.handleNotify(ackOf(sentRequest(stub.sent)))).toBe(false);
    expect(settled).toBe(true);
  });

  it('two clients each consume only their own reply', async () => {
    const shared = stubRuntime();
    const sidebar = clientOf(shared);
    const editor = clientOf(shared);

    const sidebarCall = sidebar.call('omit', omitInit);
    await flushed();
    const sidebarReq = sentRequest(shared.sent, 0);
    const editorCall = editor.call('restore', omitInit);
    await flushed();
    const editorReq = sentRequest(shared.sent, 1);
    expect(sidebarReq.reqId).not.toBe(editorReq.reqId);

    // Every surface sees every notify; only the issuer may take it.
    expect(editor.handleNotify(ackOf(sidebarReq))).toBe(false);
    expect(sidebar.handleNotify(ackOf(sidebarReq))).toBe(true);
    expect(sidebar.handleNotify(ackOf(editorReq))).toBe(false);
    expect(editor.handleNotify(ackOf(editorReq))).toBe(true);

    await expect(sidebarCall).resolves.toMatchObject({ ok: true, op: 'omit' });
    await expect(editorCall).resolves.toMatchObject({
      ok: true,
      op: 'restore',
    });
    expect(pendingOf(sidebar).size).toBe(0);
    expect(pendingOf(editor).size).toBe(0);
  });

  it('forwards an error reply verbatim', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    const call = client.call('revert', { entryId: 'e7' });
    await flushed();
    const request = sentRequest(stub.sent);
    const refused: BridgeReply = {
      v: 1,
      reqId: request.reqId,
      op: request.op,
      ok: false,
      code: 'busy',
      error: 'agent is streaming',
    };
    expect(client.handleNotify(encodeBridgeReply(refused))).toBe(true);
    const reply = await call;
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('expected an error reply');
    expect(reply.code).toBe('busy');
    expect(reply.error).toBe('agent is streaming');
  });

  it('reports a call that never reached pi, instead of waiting for the watchdog', async () => {
    // No runtime bound: the prompt cannot even be attempted.
    const orphan = new BridgeClient(() => null, logger);
    const reply = await orphan.call('hello');
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error('expected an error reply');
    expect(reply.code).toBe('unsupported');
    expect(pendingOf(orphan).size).toBe(0);

    // pi refused to run the command (an answer of `queued`): no ack is ever coming.
    const refused = clientOf(stubRuntime({ disposition: 'queued' }));
    const refusedReply = await refused.call('hello');
    expect(refusedReply.ok).toBe(false);
    if (refusedReply.ok) throw new Error('expected an error reply');
    expect(refusedReply.code).toBe('unsupported');
    expect(pendingOf(refused).size).toBe(0);
  });

  it('probes capabilities once and remembers them', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    expect(client.capabilities()).toBeUndefined();

    const probe = client.refreshCapabilities();
    await flushed();
    const hello = sentRequest(stub.sent);
    expect(hello.op).toBe('hello');
    expect(
      client.handleNotify(
        encodeBridgeReply({ ...hello, ok: true, capabilities }),
      ),
    ).toBe(true);
    await expect(probe).resolves.toEqual(capabilities);
    expect(client.capabilities()).toEqual(capabilities);

    // A second probe is free: a loaded child cannot change what it supports.
    await expect(client.refreshCapabilities()).resolves.toEqual(capabilities);
    expect(stub.sent).toHaveLength(1);
  });

  it('answers a failed probe with nothing remembered', async () => {
    const stub = stubRuntime({ loaded: false });
    const client = clientOf(stub);
    const probe = client.refreshCapabilities();
    await flushed();
    client.handleNotify(
      encodeBridgeReply({
        ...sentRequest(stub.sent),
        ok: false,
        code: 'unsupported',
        error: 'no bridge',
      }),
    );
    await expect(probe).resolves.toBeUndefined();
    expect(client.capabilities()).toBeUndefined();
  });

  it('leaves nothing armed after dispose', async () => {
    const stub = stubRuntime();
    const client = clientOf(stub);
    const call = client.call('omit', omitInit);
    await flushed();
    expect(pendingOf(client).size).toBe(1);

    client.dispose();
    await expect(call).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    expect(pendingOf(client).size).toBe(0);

    // A later op on a disposed client is refused without touching the runtime.
    const after = await client.call('omit', omitInit);
    expect(after.ok).toBe(false);
    expect(stub.sent).toHaveLength(1);
  });
});
