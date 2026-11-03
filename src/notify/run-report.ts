/**
 * Deciding that a run has produced its final report, and what to tell the human about it.
 *
 * Nothing here imports `vscode`: {@link RunWatcher} eats the events a run ends with and returns a
 * {@link FinishedRun} when one of them means "there is something to read". Three end-of-work events cross
 * the wire and they do not mean the same thing:
 *
 * - `turn_end` — one LLM call, usually followed by tool results and another turn. Never the end.
 * - `agent_end` — a loop finished with a finished reply. A *clean* reply here is the report the human is
 *   waiting for, so this is the event to announce: it is immediate, whereas `agent_settled` can be minutes
 *   behind it.
 * - `agent_settled` — the whole run, retries and compaction included, with `aborted` saying whether the
 *   human pressed Stop. A run that did *not* end cleanly may still continue (retry, auto-recover from a
 *   truncated reply, compaction and re-issue), so a failure is only announced from here — and dropped
 *   altogether if the run turns out to have been cancelled.
 *
 * `agent_end.willRetry` alone cannot make that call: it is pi's auto-retry predicate, and it says nothing
 * about the compaction and recovery paths that also continue a run.
 */

import { textOfContent } from '../../shared/blocks';
import type { AppMessage, RpcEvent } from '../../shared/protocol';
import { summarize, type AttentionMessage } from './attention';

/** How a run stopped, in the words a notification needs. */
export type RunOutcome = 'done' | 'error' | 'truncated';

export interface FinishedRun {
  /** `done` = a final report; the others are the run stopping without one. */
  outcome: RunOutcome;
  /** The reply as one capped line — empty when the model returned no text. */
  report: string;
  /** Provider message when {@link outcome} is `error`. */
  error?: string;
  /** The reply's own stop reason, for the log line. */
  stopReason: string;
}

/**
 * How long an announced report is remembered. A loop that ends a second time with the same reply — a
 * re-issued answer, not new work — must not ping twice, but a memory kept forever would swallow an
 * identical, genuinely new report much later in the session.
 */
const REPEAT_SUPPRESS_MS = 2 * 60_000;

/** Per-runtime state across the events of one run. */
export class RunWatcher {
  /** Newest assistant reply seen in the current loop — the report, until the run continues. */
  private reply?: AppMessage;
  /** Last announced report, with the time it went out (see {@link REPEAT_SUPPRESS_MS}). */
  private announced?: { report: string; at: number };
  /** A reply that ended badly, held until the run proves it is really over. */
  private held?: FinishedRun;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Consume one runtime event, returning {@link FinishedRun} for the event that settled a report. Every
   * other event only updates what is remembered, and returns `null`.
   */
  feed(event: RpcEvent): FinishedRun | null {
    switch (event.type) {
      case 'agent_start':
        // A new loop is on its way: never report the previous one's message twice, and never carry a
        // failure across a run boundary (a child killed before `agent_settled` leaves its `held` behind).
        this.reply = undefined;
        this.held = undefined;
        return null;
      case 'turn_end':
      case 'message_end': {
        const message = (event as { message?: AppMessage }).message;
        if (message?.role === 'assistant') this.reply = message;
        return null;
      }
      case 'agent_end':
        return this.announce(
          this.reply ??
            lastAssistant((event as { messages?: AppMessage[] }).messages),
        );
      case 'agent_settled':
        return this.settle(event.aborted === true);
      default:
        return null;
    }
  }

  /** A loop finished. Only a clean reply is announced; a bad one is held for {@link settle}. */
  private announce(last: AppMessage | undefined): FinishedRun | null {
    if (!last) return null;
    const stopReason =
      typeof last.stopReason === 'string' ? last.stopReason : 'stop';
    // The human pressed Stop. Nothing they did needs announcing, and `agent_settled` will confirm it.
    if (stopReason === 'aborted') {
      this.held = undefined;
      return null;
    }
    if (stopReason !== 'error' && stopReason !== 'length') {
      // `'stop'` is the report; anything else the runtime may yet learn to send is treated as one too —
      // a missed ping is worse than a ping about an unfinished-sounding reply.
      const report = summarize(textOfContent(last.content, ' '));
      const fresh =
        !this.announced ||
        this.announced.report !== report ||
        this.now() - this.announced.at > REPEAT_SUPPRESS_MS;
      if (!fresh) return null;
      this.announced = { report, at: this.now() };
      this.held = undefined;
      return { outcome: 'done', report, stopReason };
    }
    const failure: FinishedRun = {
      outcome: stopReason === 'error' ? 'error' : 'truncated',
      report: summarize(textOfContent(last.content, ' ')),
      error: errorOf(last),
      stopReason,
    };
    // Retry, truncation recovery and compaction all re-enter the loop after this event, and a second
    // `agent_end` is on its way. Announcing now would call a continuing run a failed one. (`agent_end`'
    // own `willRetry` flag is not enough to decide: it is the auto-retry predicate, and the other three
    // paths continue the run without setting it.)
    this.held = failure;
    return null;
  }

  /**
   * The run cannot settle any more — its child exited. Release whatever it ended on, so a failure is not
   * lost with the process that produced it.
   */
  abandon(): FinishedRun | null {
    const held = this.held;
    this.held = undefined;
    this.announced = undefined;
    this.reply = undefined;
    return held ?? null;
  }

  /** The run is over: release what it ended on, unless it ended because the human ended it. */
  private settle(aborted: boolean): FinishedRun | null {
    const held = this.held;
    this.held = undefined;
    this.announced = undefined;
    this.reply = undefined;
    if (aborted) return null;
    if (held) this.announced = { report: held.report, at: this.now() };
    return held ?? null;
  }
}

/** The provider's own words, when the reply carries any. */
function errorOf(message: AppMessage): string | undefined {
  const text = message.errorMessage;
  return typeof text === 'string' && text.trim() ? summarize(text) : undefined;
}

/** Newest assistant message of an `agent_end` recap (the streamed events are the normal source). */
function lastAssistant(messages?: AppMessage[]): AppMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return undefined;
}

/** The notification for a finished run. */
export function describeFinishedRun(
  run: FinishedRun,
  project: string,
): AttentionMessage {
  const title =
    run.outcome === 'error'
      ? `${project}: run failed`
      : run.outcome === 'truncated'
        ? `${project}: reply cut off`
        : `${project}: report ready`;
  const body =
    run.outcome === 'error'
      ? (run.error ?? 'The run stopped on a provider error.')
      : run.report || '(the reply had no text)';
  return { title, body, critical: false };
}
