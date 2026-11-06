/**
 * The wire contract between the Amulet extension host and the pi extension it ships
 * (`pi-bridge/`).
 *
 * Why this file exists: `pi --mode rpc` exposes a closed set of commands and not one of them mutates
 * an existing session entry, so the mutations Amulet needs (omit a tool result from context, replace
 * its text, rewind the tail of the conversation) have to run inside the child process. They are
 * therefore requested by *running an extension command* — `/amulet <json>` — and answered out-of-band
 * by `ctx.ui.notify('amulet:reply <json>')`, which the host intercepts before it can become a toast.
 *
 * Both halves are this file's business: nothing else may assume a shape for that JSON.
 *
 * Transport rules, all of them load-bearing:
 *  - One line only. `JSON.stringify` escapes newlines and quotes, which is what lets arbitrary edited
 *    text (including a `--- pi-extension-context:end ---` lookalike) travel without injection.
 *  - The command is submitted as a `prompt`, so pi's own matcher decides whether it is a command at all
 *    (see `shared/command-invocation.ts`); that is why the reply is a notify and not the response.
 *  - A reply is matched to its caller by `reqId`, which the requesting bridge owns. Nothing is
 *    broadcast, so two surfaces cannot double-apply one operation.
 */

/** The command name the bridge registers (`/amulet`). It shows up in the user's slash menu. */
export const BRIDGE_COMMAND_NAME = 'amulet';

/** Every ack the bridge emits is a notify whose text starts with this. */
export const BRIDGE_REPLY_PREFIX = 'amulet:reply ';

/** Bumped only for a breaking change in the request/reply shape below. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/**
 * What an omitted tool result reads as, from now until it is restored.
 *
 * A placeholder rather than a deletion, and a shared constant rather than an implementation detail: the
 * call keeps an answer (so the provider request stays valid), the reply that made it stays in context and
 * in the transcript, and the host recognises a durable `context_edit` carrying this exact text as an
 * **omission** — which is how a reloaded session knows to paint the original output again.
 */
export const CONTEXT_OMIT_PLACEHOLDER = '[Omitted from context by the user.]';

/**
 * What the host can ask for.
 *
 * `hello` is a capability probe with no side effect; the others are the three user-facing features
 * plus their inverses. `undo-revert` is separate from `revert` because it targets the leaf the last
 * revert abandoned rather than a message the user picked.
 */
export type BridgeOp =
  'hello' | 'omit' | 'replace' | 'restore' | 'revert' | 'undo-revert';

export const BRIDGE_OPS: readonly BridgeOp[] = [
  'hello',
  'omit',
  'replace',
  'restore',
  'revert',
  'undo-revert',
];

/**
 * How the host names the thing to edit. It never learns pi's entry ids for a live card — history
 * messages carry no id — so it addresses the tool call the card already has, and the bridge resolves
 * that to session entries, which is the only side that can read the session tree cheaply.
 */
export type BridgeHandle =
  | { kind: 'toolCall'; toolCallId: string }
  | { kind: 'entry'; entryId: string }
  | { kind: 'userText'; text: string; occurrence?: 'newest' | number };

/** One operation, as it crosses the wire in the command arguments. */
export interface BridgeRequest {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  reqId: string;
  op: BridgeOp;
  /** Required by `omit`, `replace`, `restore`. */
  handle?: BridgeHandle;
  /** Required by `revert` and `undo-revert`: the entry to move the leaf to. */
  entryId?: string;
  /** Required by `replace`: the text the model should read from now on. */
  content?: string;
  /** Always false in v1 — a branch summary is an LLM call that appends content and busts the cache. */
  summarize?: false;
}

/** A request-shaped object that failed validation. */
export interface BridgeRequestError {
  error: string;
}

/** One session entry the bridge actually touched, echoed back so the UI can show what left context. */
export interface BridgeTargetView {
  entryId: string;
  role: 'user' | 'assistant' | 'toolResult';
  /** Set for the entries a tool card can badge (the call itself and its results). */
  toolCallId?: string;
}

/** What the loaded child can do. Probed once, then trusted for the life of the process. */
export interface BridgeCapabilities {
  /** `context_edit` entries exist and the `context` hook can apply them. */
  contextEdit: boolean;
  /** `ctx.navigateTree` is reachable from a command handler. */
  navigateTree: boolean;
  /** The runtime's own `--version` string, for the log and for the degradation notice. */
  piVersion: string;
}

/** Why an operation did not happen. Each is a different sentence in the UI. */
export type BridgeErrorCode =
  | 'busy'
  | 'not-idle'
  | 'unknown-handle'
  | 'ambiguous-handle'
  | 'pre-compaction'
  | 'no-such-entry'
  | 'cancelled'
  | 'unsupported';

export const BRIDGE_ERROR_CODES: readonly BridgeErrorCode[] = [
  'busy',
  'not-idle',
  'unknown-handle',
  'ambiguous-handle',
  'pre-compaction',
  'no-such-entry',
  'cancelled',
  'unsupported',
];

export interface BridgeReplyOk {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  reqId: string;
  op: BridgeOp;
  ok: true;
  /** The entries the operation applied to (omit groups report every member). */
  targets?: BridgeTargetView[];
  /** `revert`/`undo-revert`: the leaf the conversation moved away from, which is what undo returns to. */
  revertedFrom?: string;
  /** `revert`/`undo-revert`: how many entries the move abandoned. */
  abandonedCount?: number;
  /** `hello` only. */
  capabilities?: BridgeCapabilities;
}

export interface BridgeReplyError {
  v: typeof BRIDGE_PROTOCOL_VERSION;
  reqId: string;
  op: BridgeOp;
  ok: false;
  error: string;
  code: BridgeErrorCode;
}

export type BridgeReply = BridgeReplyOk | BridgeReplyError;

/** `/amulet {"v":1,...}` — a single line, because pi splits the command name at the first space. */
export function encodeBridgeRequest(request: BridgeRequest): string {
  return `/${BRIDGE_COMMAND_NAME} ${JSON.stringify(request)}`;
}

/** `amulet:reply {"v":1,...}` — the text of the `ctx.ui.notify` ack. */
export function encodeBridgeReply(reply: BridgeReply): string {
  return `${BRIDGE_REPLY_PREFIX}${JSON.stringify(reply)}`;
}

/** Whether {@link value} is a request the bridge may act on (as opposed to {@link BridgeRequestError}). */
export function isBridgeRequest(
  value: BridgeRequest | BridgeRequestError,
): value is BridgeRequest {
  return (value as BridgeRequestError).error === undefined;
}

/**
 * Parse the text a command handler receives.
 *
 * Accepts both the raw argument string pi hands the handler and a whole `/amulet …` line, so a caller
 * that still has the submission can use this too — and, in that second form, gets told when the
 * invocation is for some other command rather than for the bridge.
 */
export function parseBridgeRequestArgs(
  args: string,
): BridgeRequest | BridgeRequestError {
  const payload = stripCommandPrefix(args);
  if ('error' in payload) return payload;
  const raw = readJson(payload.text);
  if ('error' in raw) return raw;
  return validateRequest(raw.value);
}

/**
 * Recognise one bridge ack.
 *
 * Returns null for every other extension's notify — including a `pi-gate` approval toast that happens
 * to contain JSON — so the caller can pass anything through and leave the unmatched text to the
 * normal notification path.
 */
export function parseBridgeReply(message: string): BridgeReply | null {
  if (!message.startsWith(BRIDGE_REPLY_PREFIX)) return null;
  const raw = readJson(message.slice(BRIDGE_REPLY_PREFIX.length));
  if ('error' in raw) return null;
  return validateReply(raw.value);
}

/** Build the request the host sends, filling in the protocol fields. */
export function buildBridgeRequest(
  reqId: string,
  op: BridgeOp,
  init: Omit<BridgeRequest, 'v' | 'reqId' | 'op'> = {},
): BridgeRequest {
  return { v: BRIDGE_PROTOCOL_VERSION, reqId, op, ...init };
}

/** Strip the command prefix, checking that the invocation names *this* command. */
function stripCommandPrefix(
  args: string,
): { text: string } | BridgeRequestError {
  const text = args.trim();
  if (!text.startsWith('/')) return { text };
  const space = text.indexOf(' ');
  const name = space < 0 ? text.slice(1) : text.slice(1, space);
  if (name !== BRIDGE_COMMAND_NAME) {
    return { error: `"${name}" is not the Amulet bridge command` };
  }
  if (space < 0) return { error: 'missing bridge request payload' };
  return { text: text.slice(space + 1).trim() };
}

function readJson(text: string): { value: unknown } | BridgeRequestError {
  if (!text) return { error: 'missing bridge request payload' };
  try {
    return { value: JSON.parse(text) };
  } catch {
    // A command typed by a human, or a truncated payload. Either way: not our JSON.
    return { error: 'bridge payload is not valid JSON' };
  }
}

const REQ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateRequest(value: unknown): BridgeRequest | BridgeRequestError {
  if (!isRecord(value)) return { error: 'bridge payload must be an object' };
  if (value.v !== BRIDGE_PROTOCOL_VERSION)
    return { error: `unsupported bridge protocol version` };
  if (typeof value.reqId !== 'string' || !REQ_ID_RE.test(value.reqId)) {
    return { error: 'bridge request needs a reqId' };
  }
  const reqId = value.reqId;
  if (
    typeof value.op !== 'string' ||
    !BRIDGE_OPS.includes(value.op as BridgeOp)
  ) {
    return { error: `unknown bridge op ${JSON.stringify(value.op)}` };
  }
  const op = value.op as BridgeOp;
  const request: BridgeRequest = { v: BRIDGE_PROTOCOL_VERSION, reqId, op };

  if (value.handle !== undefined) {
    const handle = readHandle(value.handle);
    if ('error' in handle) return { error: handle.error };
    request.handle = handle.handle;
  }
  if (value.entryId !== undefined) {
    if (typeof value.entryId !== 'string' || !value.entryId) {
      return { error: 'bridge entryId must be a non-empty string' };
    }
    request.entryId = value.entryId;
  }
  if (value.content !== undefined) {
    if (typeof value.content !== 'string')
      return { error: 'bridge content must be a string' };
    request.content = value.content;
  }
  if (value.summarize !== undefined) {
    if (value.summarize !== false)
      return { error: 'summarized reverts are not supported' };
    request.summarize = false;
  }

  switch (op) {
    case 'omit':
    case 'restore':
      if (!request.handle) return { error: `${op} needs a handle` };
      break;
    case 'replace':
      if (!request.handle) return { error: 'replace needs a handle' };
      if (request.content === undefined)
        return { error: 'replace needs content' };
      break;
    case 'revert':
    case 'undo-revert':
      if (!request.entryId) return { error: `${op} needs an entryId` };
      break;
    case 'hello':
      break;
  }
  return request;
}

function readHandle(
  value: unknown,
): { handle: BridgeHandle } | BridgeRequestError {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return { error: 'bridge handle must be an object with a kind' };
  }
  switch (value.kind) {
    case 'toolCall': {
      if (typeof value.toolCallId !== 'string' || !value.toolCallId) {
        return { error: 'toolCall handle needs a toolCallId' };
      }
      return { handle: { kind: 'toolCall', toolCallId: value.toolCallId } };
    }
    case 'entry': {
      if (typeof value.entryId !== 'string' || !value.entryId) {
        return { error: 'entry handle needs an entryId' };
      }
      return { handle: { kind: 'entry', entryId: value.entryId } };
    }
    case 'userText': {
      if (typeof value.text !== 'string' || !value.text) {
        return { error: 'userText handle needs text' };
      }
      const occurrence = value.occurrence;
      if (occurrence === undefined)
        return { handle: { kind: 'userText', text: value.text } };
      if (occurrence === 'newest')
        return { handle: { kind: 'userText', text: value.text, occurrence } };
      if (typeof occurrence === 'number' && Number.isInteger(occurrence)) {
        return { handle: { kind: 'userText', text: value.text, occurrence } };
      }
      return { error: 'userText occurrence must be "newest" or an integer' };
    }
    default:
      return {
        error: `unknown bridge handle kind ${JSON.stringify(value.kind)}`,
      };
  }
}

function validateReply(value: unknown): BridgeReply | null {
  if (!isRecord(value)) return null;
  if (value.v !== BRIDGE_PROTOCOL_VERSION) return null;
  if (typeof value.reqId !== 'string' || !REQ_ID_RE.test(value.reqId))
    return null;
  if (
    typeof value.op !== 'string' ||
    !BRIDGE_OPS.includes(value.op as BridgeOp)
  )
    return null;
  const reqId = value.reqId;
  const op = value.op as BridgeOp;
  if (value.ok !== true && value.ok !== false) return null;

  if (value.ok === false) {
    if (typeof value.error !== 'string') return null;
    if (
      typeof value.code !== 'string' ||
      !BRIDGE_ERROR_CODES.includes(value.code as BridgeErrorCode)
    ) {
      return null;
    }
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      reqId,
      op,
      ok: false,
      error: value.error,
      code: value.code as BridgeErrorCode,
    };
  }

  const reply: BridgeReplyOk = {
    v: BRIDGE_PROTOCOL_VERSION,
    reqId,
    op,
    ok: true,
  };
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets)) return null;
    const targets: BridgeTargetView[] = [];
    for (const target of value.targets) {
      if (!isRecord(target) || typeof target.entryId !== 'string') return null;
      if (
        target.role !== 'user' &&
        target.role !== 'assistant' &&
        target.role !== 'toolResult'
      ) {
        return null;
      }
      const view: BridgeTargetView = {
        entryId: target.entryId,
        role: target.role,
      };
      if (typeof target.toolCallId === 'string')
        view.toolCallId = target.toolCallId;
      targets.push(view);
    }
    reply.targets = targets;
  }
  if (value.revertedFrom !== undefined) {
    if (typeof value.revertedFrom !== 'string') return null;
    reply.revertedFrom = value.revertedFrom;
  }
  if (value.abandonedCount !== undefined) {
    if (typeof value.abandonedCount !== 'number') return null;
    reply.abandonedCount = value.abandonedCount;
  }
  if (value.capabilities !== undefined) {
    const caps = value.capabilities;
    if (
      !isRecord(caps) ||
      typeof caps.contextEdit !== 'boolean' ||
      typeof caps.navigateTree !== 'boolean' ||
      typeof caps.piVersion !== 'string'
    ) {
      return null;
    }
    reply.capabilities = {
      contextEdit: caps.contextEdit,
      navigateTree: caps.navigateTree,
      piVersion: caps.piVersion,
    };
  }
  return reply;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
