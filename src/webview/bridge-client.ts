import { randomUUID } from 'node:crypto';
import {
  BRIDGE_COMMAND_NAME,
  BRIDGE_REPLY_PREFIX,
  buildBridgeRequest,
  encodeBridgeRequest,
  parseBridgeReply,
  type BridgeCapabilities,
  type BridgeErrorCode,
  type BridgeOp,
  type BridgeReply,
  type BridgeRequest,
} from '../../shared/bridge-protocol';
import type { Logger, PiRuntime } from '../runtime/pi-runtime';

/**
 * The host half of the Amulet bridge (`pi-bridge/`).
 *
 * One `BridgeClient` belongs to one surface (see the plan's F-5): the runtime is shared by the sidebar
 * and every editor tab, but the *caller* of an operation is a single surface, so the ack must be claimed
 * by the client that issued it and not applied N times. That is the whole reason `pending` is per bridge.
 *
 * What it does:
 *  - sends `/amulet <json>` as a `prompt` with the long budget, exactly like `ChatBridge.submitText`,
 *    because pi resolves that response only when the command handler returns;
 *  - waits for the matching `amulet:reply` notify, which arrives on the extension-UI channel — the one
 *    output path an extension command has (`handled` writes nothing to the session and emits no events);
 *  - answers on a watchdog instead of hanging, because a wedged child must not park a button click.
 *
 * Deliberately free of `vscode` imports, so the correlation logic is unit-testable.
 */

/**
 * How long to wait for the ack after the command was submitted. A revert with `summarize:false` is one
 * in-process tree move and an omit is a map write, so anything close to this budget means the handler
 * never ran or never returned — while pi's own budget for a long-running command is 15 *minutes*, far too
 * long to leave a button click without an answer.
 */
export const BRIDGE_ACK_TIMEOUT_MS = 15_000;

/** Text whose first token pi matches against the registered commands; enough to ask "is it loaded?". */
const BRIDGE_PROBE_TEXT = `/${BRIDGE_COMMAND_NAME}`;

/** The watchdog's rejection. Only {@link BridgeClient.call} ever sees it: it reports an error reply. */
class BridgeAckTimeout extends Error {}

/** One call waiting for its ack. */
interface PendingCall {
  op: BridgeOp;
  reqId: string;
  promise: Promise<BridgeReply>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (reply: BridgeReply) => void;
  reject: (err: Error) => void;
}

export class BridgeClient {
  /** reqId → the call waiting for it. Owned by this surface, and the only thing `handleNotify` claims. */
  private readonly pending = new Map<string, PendingCall>();
  /** Probed once, then trusted for the life of this process (a loaded child cannot gain a capability). */
  private caps: BridgeCapabilities | undefined;
  private disposed = false;

  constructor(
    private readonly getRuntime: () => PiRuntime | null,
    private readonly log: Logger,
  ) {}

  /**
   * Whether the child process loaded the bridge — read from the runtime's cached `get_commands`, never
   * from a name we assume. False while that list has not been fetched yet (see
   * {@link PiRuntime.isExtensionCommand}), so a caller checks it again after a snapshot was pushed.
   */
  isAvailable(): boolean {
    const runtime = this.getRuntime();
    return !!runtime && runtime.isExtensionCommand(BRIDGE_PROBE_TEXT);
  }

  /** What the loaded bridge reported, or undefined before a successful {@link refreshCapabilities}. */
  capabilities(): BridgeCapabilities | undefined {
    return this.caps;
  }

  /**
   * Ask the bridge what it can do — one `hello` round trip, then remembered for this process.
   *
   * Returns undefined (and logs why) instead of throwing: its only consumer is a UI that hides the
   * actions the runtime cannot perform.
   */
  async refreshCapabilities(): Promise<BridgeCapabilities | undefined> {
    if (this.caps) return this.caps;
    const reply = await this.call('hello');
    if (!reply.ok || !reply.capabilities) {
      this.log.warn(
        `Amulet bridge did not answer the capability probe: ${
          reply.ok ? 'the reply carried no capabilities' : reply.error
        }`,
      );
      return undefined;
    }
    this.caps = reply.capabilities;
    this.log.info(
      `Amulet bridge ready (pi ${this.caps.piVersion}; context_edit=${this.caps.contextEdit}, ` +
        `navigateTree=${this.caps.navigateTree}, toolStop=${this.caps.toolStop === true}).`,
    );
    return this.caps;
  }

  /**
   * Run one bridge operation and wait for its ack.
   *
   * Always resolves with a reply: the watchdog and an unreachable runtime both come back as
   * `ok:false`, so a caller only ever reads `reply.ok` and never has to catch.
   */
  async call(
    op: BridgeOp,
    init: Omit<BridgeRequest, 'v' | 'reqId' | 'op'> = {},
  ): Promise<BridgeReply> {
    const reqId = randomUUID();
    if (this.disposed) {
      return errorReply(op, reqId, 'unsupported', 'This chat has been closed.');
    }
    const request = buildBridgeRequest(reqId, op, init);
    const call = this.track(op, reqId);
    try {
      await this.send(request);
    } catch (err) {
      // No child, no command, and no reply can ever arrive: report it now instead of after the watchdog.
      return this.fail(call, 'unsupported', err);
    }
    try {
      return await call.promise;
    } catch (err) {
      if (!(err instanceof BridgeAckTimeout)) throw err;
      return errorReply(
        op,
        reqId,
        'busy',
        `The Amulet bridge did not answer the "${op}" operation within ${Math.round(
          BRIDGE_ACK_TIMEOUT_MS / 1000,
        )}s. The agent may be busy — try again once the run has stopped.`,
      );
    } finally {
      // Whatever happened, this reqId is no longer live: a reply that lands late must not be applied
      // twice (F-6), and a timer that outlives its call is a leak.
      this.settle(call);
    }
  }

  /**
   * Offer one `extension_ui_request` notify text to this bridge.
   *
   * True means this client issued the operation behind it and has resolved its caller, so the host must
   * not turn the text into a toast. Anything else returns false and stays on the normal notification
   * path: every other extension's notify, and a reply whose reqId this surface did not issue — which is
   * another surface's client (F-5) or a call this watchdog already gave up on (F-6).
   */
  handleNotify(message: string): boolean {
    if (!message.startsWith(BRIDGE_REPLY_PREFIX)) return false;
    const reply = parseBridgeReply(message);
    if (!reply) return false;
    const call = this.pending.get(reply.reqId);
    if (!call) return false;
    this.pending.delete(reply.reqId);
    clearTimeout(call.timer);
    if (reply.op !== call.op) {
      // A reply that answers a different question than the one this reqId was minted for is a bridge
      // bug, not an answer: applying it would badge an operation nobody ran.
      this.log.warn(
        `Bridge answered "${reply.op}" to a "${call.op}" request; ignoring.`,
      );
      call.resolve(
        errorReply(
          call.op,
          call.reqId,
          'busy',
          `The bridge replied about "${reply.op}" instead of "${call.op}".`,
        ),
      );
      return true;
    }
    call.resolve(reply);
    return true;
  }

  /**
   * Fail every call this client is still waiting on, without tearing the client down.
   *
   * Called when the surface re-attaches to a runtime: the child that was asked may be gone, and a card
   * must not stay marked as waiting on an answer that can no longer be produced.
   */
  cancelOutstanding(reason: string): void {
    for (const call of [...this.pending.values()]) {
      this.settle(call);
      call.resolve(errorReply(call.op, call.reqId, 'cancelled', reason));
    }
  }

  /** Drop every outstanding call: the surface is gone, and nobody is left to read a reply. */
  dispose(): void {
    this.disposed = true;
    const open = [...this.pending.values()];
    for (const call of open) {
      this.settle(call);
      // Deliberately not a rejection: a caller only ever reads `reply.ok`, and the exception would have
      // no reader left once the webview behind this surface is gone.
      call.resolve(
        errorReply(
          call.op,
          call.reqId,
          'cancelled',
          'This chat was closed before the bridge answered.',
        ),
      );
    }
    if (open.length) {
      this.log.info(
        `Bridge client disposed with ${open.length} unanswered call(s).`,
      );
    }
  }

  /** The one submission route: a bridge call is an extension command, so it goes out as a prompt. */
  private async send(request: BridgeRequest): Promise<void> {
    const runtime = this.getRuntime();
    if (!runtime) throw new Error('no pi runtime is bound to this chat');
    const disposition = await runtime.prompt(
      encodeBridgeRequest(request),
      undefined,
      // An extension command's response only lands when its handler returns, so it needs the long
      // budget — the generic one fails a command that worked. Same argument as in `submitText`.
      { longRunning: true },
    );
    // `handled` is the only answer that means the bridge ran. Anything else (a queued or plain-started
    // prompt) says no handler executed, so no ack can arrive. An old pi reports nothing, and there the
    // watchdog decides.
    if (disposition !== undefined && disposition !== 'handled') {
      throw new Error(
        `pi answered with disposition "${disposition}" instead of running the bridge command.`,
      );
    }
  }

  /** Arm the watchdog and register the pending call. */
  private track(op: BridgeOp, reqId: string): PendingCall {
    let resolve!: (reply: BridgeReply) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<BridgeReply>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      // Forget the reqId *before* reporting: an ack that arrives after this is not ours any more, and
      // applying it would double the effect of an operation already given up on.
      this.pending.delete(reqId);
      this.log.warn(
        `Bridge op "${op}" did not answer within ${BRIDGE_ACK_TIMEOUT_MS / 1000}s.`,
      );
      reject(new BridgeAckTimeout(op));
    }, BRIDGE_ACK_TIMEOUT_MS);
    const call: PendingCall = { op, reqId, promise, timer, resolve, reject };
    // Attached here, at the moment the watchdog exists: `call()` only awaits the promise after `send()`
    // resolved, and a command whose response is parked (a dialog, a wedged child) can time out *during*
    // that await — which would otherwise be an unhandled rejection in the extension host.
    promise.catch(() => undefined);
    this.pending.set(reqId, call);
    return call;
  }

  /** Clear the watchdog and forget the reqId. Idempotent, and always called from a `finally`. */
  private settle(call: PendingCall): void {
    clearTimeout(call.timer);
    this.pending.delete(call.reqId);
  }

  /** Kill a call that can never be answered, and say why. */
  private fail(
    call: PendingCall,
    code: BridgeErrorCode,
    err: unknown,
  ): BridgeReply {
    this.settle(call);
    const reason = err instanceof Error ? err.message : String(err);
    this.log.warn(`Bridge op "${call.op}" could not run: ${reason}`);
    return errorReply(
      call.op,
      call.reqId,
      code,
      `The Amulet bridge could not be reached: ${reason}`,
    );
  }
}

/** The error shape every non-reply outcome is reported as, so callers only have to read `reply.ok`. */
function errorReply(
  op: BridgeOp,
  reqId: string,
  code: BridgeErrorCode,
  message: string,
): BridgeReply {
  return { v: 1, reqId, op, ok: false, error: message, code };
}
