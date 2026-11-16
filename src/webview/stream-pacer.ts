/**
 * Chunking of the streamed deltas of one webview surface (menu: **Reduced motion**).
 *
 * `pi --mode rpc` emits one `message_update` per token, and every one of them is a `postMessage`,
 * a reducer run, a full-transcript render and — for the block that grew — a fresh markdown parse.
 * That is the honest default (text appears exactly as it is read), but it is also the whole cost
 * of a long answer paid 60 times a second. When the switch is on, consecutive deltas of the same
 * content slot are folded together and handed over on a fixed cadence instead, so the transcript
 * repaints in chunks while the conversation, the session file and the final payload stay identical.
 *
 * Two rules make that safe, and both are load-bearing:
 *
 * - **Order is never changed.** Only the *last* queued event may absorb a new one, and only when it
 *   is the same delta kind for the same `contentIndex`. A `text_end`, a `tool_execution_start` or
 *   any other event flushes the queue *first*, so the webview never sees a wire event land after a
 *   delta that came after it.
 * - **Nothing is mutated.** One event object is fanned out to every surface of a runtime, so a
 *   merged delta is always a new object — the other bridges get their own copies through their own
 *   pacer.
 */
import type { RpcEvent } from '../../shared/protocol';

/**
 * How long a delta may wait for its chunk. ~8 repaints a second: still visibly live, one tenth of
 * the renders of the token path. A shorter interval is a smoother stream, a longer one is a lazier
 * one — the events are folded either way, so this only trades latency against paint cost.
 */
export const STREAM_PACE_MS = 120;

/** The delta kinds that carry appendable text. */
const APPENDABLE_DELTA_TYPES: ReadonlySet<string> = new Set([
  'text_delta',
  'thinking_delta',
  'toolcall_delta',
]);

/** The one wire event whose payload is a stream fragment. */
const DELTA_EVENT = 'message_update';

/** A stream fragment as it arrives: the fields past `type` depend on the kind. */
type StreamFragment = { type: string; contentIndex?: number; [k: string]: unknown };

function streamEventOf(event: RpcEvent): StreamFragment | undefined {
  const ae = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
  return ae && typeof ae === 'object' ? (ae as StreamFragment) : undefined;
}

function deltaTextOf(fragment: StreamFragment): string | undefined {
  return typeof fragment.delta === 'string' ? fragment.delta : undefined;
}

/** Is this a cumulative-snapshot update (pre-1.x runtimes)? */
function isSnapshotUpdate(event: RpcEvent): boolean {
  const e = event as { message?: unknown; assistantMessageEvent?: unknown };
  return e.message !== undefined && e.assistantMessageEvent === undefined;
}

/**
 * Fold {@link event} into {@link pending} if it continues the fragment the queue is already
 * building, and report whether it did. A false return means the caller appends the event instead,
 * which is what keeps non-mergeable events in their original order.
 */
export function coalesceInto<T extends RpcEvent>(pending: T[], event: T): boolean {
  const last = pending[pending.length - 1];
  if (!last) return false;

  // An old runtime streams the whole partial message instead of deltas: each one supersedes the
  // previous, so the newest is all the renderer needs.
  if (isSnapshotUpdate(last) && isSnapshotUpdate(event)) {
    pending[pending.length - 1] = event;
    return true;
  }

  const lastEvent = streamEventOf(last);
  const nextEvent = streamEventOf(event);
  if (!lastEvent || !nextEvent) return false;
  if (lastEvent.type !== nextEvent.type || lastEvent.type === undefined) return false;
  if (!APPENDABLE_DELTA_TYPES.has(lastEvent.type)) return false;
  if (lastEvent.contentIndex !== nextEvent.contentIndex) return false;

  const lastDelta = deltaTextOf(lastEvent);
  const nextDelta = deltaTextOf(nextEvent);
  if (lastDelta === undefined || nextDelta === undefined) return false;

  // Newest wins for the top-level fields (a `usage` counter that lagged a chunk would understate
  // the live context meter), and the fragment is the sum of both in arrival order.
  pending[pending.length - 1] = {
    ...event,
    assistantMessageEvent: { ...nextEvent, delta: lastDelta + nextDelta },
  } as T;
  return true;
}

export interface StreamPacerOptions<T extends { type: string }> {
  /** Hand the folded events over, in arrival order. Called at most once per interval while enabled. */
  sink: (events: T[]) => void;
  /** How long a fragment may wait. */
  intervalMs?: number;
  /** Injectable clock so a test can drive a flush without a timer. */
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Per-surface pacing of streamed deltas. `route()` is the whole interface: every wire event of the
 * runtime goes through it, and it decides between forwarding now and folding for later.
 */
export class StreamPacer<T extends { type: string }> {
  private readonly sink: (events: T[]) => void;
  private readonly intervalMs: number;
  private readonly schedule: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly unschedule: (handle: ReturnType<typeof setTimeout>) => void;
  private pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private enabled = false;

  constructor(options: StreamPacerOptions<T>) {
    this.sink = options.sink;
    this.intervalMs = options.intervalMs ?? STREAM_PACE_MS;
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.unschedule = options.unschedule ?? ((handle) => clearTimeout(handle));
  }

  get paces(): boolean {
    return this.enabled;
  }

  /**
   * Follow **Reduced motion**. Turning it off hands over whatever is queued first — a switch flipped
   * mid-answer must not strand the tail of the current chunk until the next token.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  /** Forward one wire event, folding it into the queue when pacing is on and it is a fragment. */
  route(event: T): void {
    if (!this.enabled || event.type !== DELTA_EVENT) {
      this.flush();
      this.sink([event]);
      return;
    }
    if (!coalesceInto(this.pending, event)) this.pending.push(event);
    if (this.timer === undefined) {
      this.timer = this.schedule(() => {
        this.timer = undefined;
        this.flush();
      }, this.intervalMs);
    }
  }

  /** Hand over the queue (and stop waiting for it). */
  flush(): void {
    if (this.timer !== undefined) {
      this.unschedule(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    this.sink(events);
  }

  /**
   * Forget the queue without handing it over: the surface is gone, and a webview that no longer
   * exists cannot render a chunk of a reply it will never show again.
   */
  stop(): void {
    if (this.timer !== undefined) {
      this.unschedule(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }
}
