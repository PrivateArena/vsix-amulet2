import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_COMMAND_NAME,
  encodeBridgeReply,
  parseBridgeRequestArgs,
  type BridgeReply,
  type BridgeRequest,
} from '../../shared/bridge-protocol';
import type { ExtensionUiRequest } from '../../shared/protocol';
import { BridgeClient } from './bridge-client';
import { handleExtensionUiRequest } from './extension-ui';

/**
 * `notify` has exactly one path to the human — VS Code's own toast — so the Amulet bridge's ack, which
 * has to be a notify (an extension command has no output channel), must be taken out of that path
 * here. What must not change is everything else: pi-gate's toast is the record of what it approved.
 */

const toasts = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: toasts.info,
    showWarningMessage: toasts.warn,
    showErrorMessage: toasts.error,
  },
}));

const log = { info: () => {}, warn: () => {}, error: () => {}, show: () => {} };

const notify = (message: string, notifyType?: string): ExtensionUiRequest =>
  ({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message,
    ...(notifyType ? { notifyType } : {}),
  }) as ExtensionUiRequest;

/** A client with one call in flight, so the ack of that call is claimable. */
function clientWithCallInFlight(): {
  client: BridgeClient;
  ack: () => BridgeReply;
} {
  const sent: string[] = [];
  const runtime = {
    isExtensionCommand: (text: string) =>
      text.slice(1).startsWith(BRIDGE_COMMAND_NAME),
    prompt: (text: string) => {
      sent.push(text);
      return Promise.resolve('handled' as const);
    },
  };
  const client = new BridgeClient(() => runtime as never, log);
  // The call itself is not what this file tests: it only puts a live reqId into the client's map.
  void client.call('omit', {
    handle: { kind: 'toolCall', toolCallId: 'call_1' },
  });
  return {
    client,
    ack: () => {
      const parsed = parseBridgeRequestArgs(sent[0] ?? '');
      if ('error' in parsed)
        throw new Error(`nothing was sent: ${parsed.error}`);
      const request: BridgeRequest = parsed;
      return { v: 1, reqId: request.reqId, op: request.op, ok: true };
    },
  };
}

const bridgeReply = (reply: BridgeReply): string => encodeBridgeReply(reply);

describe('extension-ui notify interception', () => {
  beforeEach(() => {
    toasts.info.mockReset();
    toasts.warn.mockReset();
    toasts.error.mockReset();
  });

  it('swallows the bridge reply this surface is waiting for', async () => {
    const { client, ack } = clientWithCallInFlight();
    const message = bridgeReply(ack());
    const response = await handleExtensionUiRequest(
      notify(message),
      log,
      (text) => client.handleNotify(text),
    );
    expect(response).toBeNull();
    expect(toasts.info).not.toHaveBeenCalled();
    // …and the ack itself is never paintable text: consumed once, so a second copy is a foreign
    // extension's notify from this bridge's point of view.
    expect(client.handleNotify(message)).toBe(false);
  });

  it('swallows a reply this surface did not issue, instead of toasting the wire', async () => {
    // Every live surface sees every notify, so the copies this bridge did not ask for arrive here too.
    // They are Amulet's own traffic either way — a toast would be JSON leaking into the human's view.
    const { client } = clientWithCallInFlight();
    const foreign = bridgeReply({
      v: 1,
      reqId: 'someone-elses-call',
      op: 'omit',
      ok: true,
    });
    expect(client.handleNotify(foreign)).toBe(false);
    expect(
      await handleExtensionUiRequest(notify(foreign), log, (text) =>
        client.handleNotify(text),
      ),
    ).toBeNull();
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it('leaves every other extension notify to VS Code', async () => {
    const { client } = clientWithCallInFlight();
    const route = (text: string) => client.handleNotify(text);
    // Asked about first, and it says no: every one of these still reaches the human.
    expect(
      await handleExtensionUiRequest(
        notify('pi-gate: allowed `npm test`'),
        log,
        route,
      ),
    ).toBeNull();
    expect(toasts.info).toHaveBeenCalledWith('pi-gate: allowed `npm test`');

    expect(
      await handleExtensionUiRequest(
        notify('pi-subagent: out of turns'),
        log,
        route,
      ),
    ).toBeNull();
    expect(toasts.info).toHaveBeenLastCalledWith('pi-subagent: out of turns');

    // The notify type still decides the channel, bridge or not.
    expect(
      await handleExtensionUiRequest(notify('careful', 'warn'), log, route),
    ).toBeNull();
    expect(toasts.warn).toHaveBeenCalledWith('careful');
    expect(
      await handleExtensionUiRequest(notify('broken', 'error'), log, route),
    ).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith('broken');
  });

  it('is unchanged when no bridge is wired in', async () => {
    expect(
      await handleExtensionUiRequest(notify('a plain notify'), log),
    ).toBeNull();
    expect(toasts.info).toHaveBeenCalledWith('a plain notify');
  });
});
