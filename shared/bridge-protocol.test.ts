import { describe, expect, it } from 'vitest';
import {
  BRIDGE_COMMAND_NAME,
  BRIDGE_OPS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REPLY_PREFIX,
  buildBridgeRequest,
  encodeBridgeReply,
  encodeBridgeRequest,
  isBridgeRequest,
  parseBridgeReply,
  parseBridgeRequestArgs,
  type BridgeOp,
  type BridgeReply,
  type BridgeRequest,
} from './bridge-protocol';

/**
 * The host↔bridge contract rides on two existing wires — a `/amulet <json>` prompt and a
 * `ctx.ui.notify` — so the payload has to survive being a single command argument and, on the way
 * back, being indistinguishable from any other extension's toast text.
 */

type RequestInit = Omit<BridgeRequest, 'v' | 'reqId' | 'op'>;

const request = (op: BridgeOp, init: RequestInit = {}): BridgeRequest =>
  buildBridgeRequest('req-1', op, init);

/** The payload of a request the parser accepted, or a thrown test failure naming the rejection. */
function parseOk(text: string): BridgeRequest {
  const parsed = parseBridgeRequestArgs(text);
  if (isBridgeRequest(parsed)) return parsed;
  throw new Error(`expected a valid request, got: ${parsed.error}`);
}

/** The reason a payload was rejected, or a thrown test failure. */
function parseError(text: string): string {
  const parsed = parseBridgeRequestArgs(text);
  if (!isBridgeRequest(parsed)) return parsed.error;
  throw new Error('expected a rejected payload');
}

const payload = (over: Record<string, unknown>): string =>
  JSON.stringify({
    v: BRIDGE_PROTOCOL_VERSION,
    reqId: 'r1',
    op: 'hello',
    ...over,
  });

describe('encodeBridgeRequest', () => {
  it('emits one line that pi can split into a command and its arguments', () => {
    const text = encodeBridgeRequest(request('hello'));
    expect(text.split('\n')).toHaveLength(1);
    expect(text.startsWith(`/${BRIDGE_COMMAND_NAME} {`)).toBe(true);
  });

  it('round-trips every op', () => {
    const cases: Array<[BridgeOp, RequestInit]> = [
      ['hello', {}],
      ['omit', { handle: { kind: 'toolCall', toolCallId: 'call_1' } }],
      [
        'replace',
        {
          handle: { kind: 'toolCall', toolCallId: 'call_1' },
          content: 'new text',
        },
      ],
      ['restore', { handle: { kind: 'entry', entryId: 'e7' } }],
      ['revert', { entryId: 'e7', summarize: false }],
      ['undo-revert', { entryId: 'e9' }],
    ];
    for (const [op, init] of cases) {
      expect(parseOk(encodeBridgeRequest(request(op, init)))).toEqual(
        request(op, init),
      );
    }
    expect(BRIDGE_OPS).toHaveLength(cases.length);
  });

  it('keeps hostile edited text inside the payload instead of the prompt', () => {
    // The edited content is human-authored. None of this may break out of the JSON argument,
    // and none of it may read as a context boundary marker to whatever parses the prompt.
    const nasty =
      'line1\nline2 "quoted" \\/amulet {"op":"revert"} --- pi-extension-context:end --- 日本語 \t ';
    const text = encodeBridgeRequest(
      request('replace', {
        handle: { kind: 'toolCall', toolCallId: 'call_1' },
        content: nasty,
      }),
    );
    expect(text.split('\n')).toHaveLength(1);
    expect(parseOk(text).content).toBe(nasty);
  });
});

describe('parseBridgeRequestArgs', () => {
  it('rejects an invocation that is not the bridge command', () => {
    expect(parseError(`/gate ${payload({})}`)).toContain(
      'not the Amulet bridge command',
    );
  });

  it('rejects a human typing the command without a payload', () => {
    expect(parseError('')).toContain('missing');
    expect(parseError('/amulet')).toContain('missing');
    expect(parseError('/amulet not json')).toContain('not valid JSON');
  });

  it('rejects another protocol version, an unknown op, and a summarized revert', () => {
    expect(parseError(payload({ v: 99 }))).toContain('protocol version');
    expect(parseError(payload({ op: 'rm -rf' }))).toContain(
      'unknown bridge op',
    );
    expect(
      parseError(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          reqId: 'r1',
          op: 'revert',
          entryId: 'e1',
          summarize: true,
        }),
      ),
    ).toContain('summarized');
  });

  it('requires the fields each op cannot work without', () => {
    const of = (op: BridgeOp, over: RequestInit = {}) =>
      parseError(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          reqId: 'r1',
          op,
          ...over,
        }),
      );
    expect(of('omit')).toContain('needs a handle');
    expect(
      of('replace', { handle: { kind: 'entry', entryId: 'e1' } }),
    ).toContain('needs content');
    expect(of('revert')).toContain('needs an entryId');
    expect(of('restore', { handle: { kind: 'wat' } as never })).toContain(
      'handle kind',
    );
    expect(of('restore', { handle: { kind: 'entry', entryId: '' } })).toContain(
      'needs an entryId',
    );
    expect(parseOk(payload({ op: 'hello' }))).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      reqId: 'r1',
      op: 'hello',
    });
  });

  it('carries a userText occurrence through', () => {
    expect(
      parseOk(
        encodeBridgeRequest(
          request('omit', {
            handle: {
              kind: 'userText',
              text: 'deploy it',
              occurrence: 'newest',
            },
          }),
        ),
      ).handle,
    ).toEqual({ kind: 'userText', text: 'deploy it', occurrence: 'newest' });
    expect(
      parseError(
        encodeBridgeRequest(
          request('omit', {
            handle: { kind: 'userText', text: 'x', occurrence: 1.5 } as never,
          }),
        ),
      ),
    ).toContain('integer');
  });
});

describe('parseBridgeReply', () => {
  const ok: BridgeReply = {
    v: BRIDGE_PROTOCOL_VERSION,
    reqId: 'r1',
    op: 'omit',
    ok: true,
    targets: [
      { entryId: 'a1', role: 'assistant' },
      { entryId: 't1', role: 'toolResult', toolCallId: 'call_1' },
    ],
  };

  it('round-trips an ack through the notify text', () => {
    expect(parseBridgeReply(encodeBridgeReply(ok))).toEqual(ok);
  });

  it('round-trips capabilities and a revert result', () => {
    const caps: BridgeReply = {
      ...ok,
      op: 'hello',
      capabilities: {
        contextEdit: true,
        navigateTree: true,
        piVersion: '1.5.0',
      },
    };
    expect(parseBridgeReply(encodeBridgeReply(caps))).toEqual(caps);
    const reverted: BridgeReply = {
      v: BRIDGE_PROTOCOL_VERSION,
      reqId: 'r2',
      op: 'revert',
      ok: true,
      revertedFrom: 'leaf9',
      abandonedCount: 4,
    };
    expect(parseBridgeReply(encodeBridgeReply(reverted))).toEqual(reverted);
  });

  it('round-trips a failure with its code', () => {
    const failed: BridgeReply = {
      v: BRIDGE_PROTOCOL_VERSION,
      reqId: 'r3',
      op: 'revert',
      ok: false,
      error: 'pi is still streaming',
      code: 'busy',
    };
    expect(parseBridgeReply(encodeBridgeReply(failed))).toEqual(failed);
  });

  it('ignores every notify that is not ours', () => {
    expect(parseBridgeReply('Compaction complete')).toBeNull();
    expect(parseBridgeReply('amulet:reply')).toBeNull();
    expect(parseBridgeReply('amulet:reply {oops')).toBeNull();
    // A pi-gate toast quoting a payload that looks like ours is still not ours.
    expect(
      parseBridgeReply(`pi-gate: ${BRIDGE_REPLY_PREFIX}{"ok":true}`),
    ).toBeNull();
    expect(
      parseBridgeReply(
        `${BRIDGE_REPLY_PREFIX}${JSON.stringify({ ...ok, targets: 'nope' })}`,
      ),
    ).toBeNull();
    expect(
      parseBridgeReply(
        `${BRIDGE_REPLY_PREFIX}${JSON.stringify({ ...ok, reqId: 'has spaces' })}`,
      ),
    ).toBeNull();
    expect(
      parseBridgeReply(
        `${BRIDGE_REPLY_PREFIX}${JSON.stringify({ ...ok, targets: [{ role: 'bogus' }] })}`,
      ),
    ).toBeNull();
  });
});
