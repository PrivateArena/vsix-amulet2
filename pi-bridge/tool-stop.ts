/**
 * Stopping one running command, and telling the model about it.
 *
 * The two halves belong together because a stop is only useful if the agent learns what happened: a bare
 * `137` reads as a crash and invites a retry of the same 50-minute command, while one line of the human's
 * own words at the head of that result closes the question. Both shapes are pi-gate's vocabulary —
 * `Allowed by user with note:` / `Blocked by user: …` (`pi-gate/handle.ts`, `pi-gate/prompt.ts`) — so an agent
 * running under the gate reads one consistent vocabulary for "a human intervened in that call".
 *
 * What makes this a *command* stop and not an abort: pi's shell tools spawn the command detached, so signalling
 * that one process group ends the command and leaves the run alone. pi then reports the call as an error result
 * (`Command exited with code 137`), the loop continues, and — for a call a subagent made — the *subagent*
 * reads the note, because a nested result travels back through the same hooks (see the header of
 * `process-tree.ts` and `pi-bridge/amulet-bridge.ts`).
 *
 * Everything here is pure: {@link planStop} takes a recorded call and a process table and decides, so the aim
 * is testable without spawning anything. Only `amulet-bridge.ts` touches the OS.
 */

import type { BridgeErrorCode } from '../shared/bridge-protocol';
import { shellCommandOf, stopNoteText } from '../shared/stop-command';
import { childrenOf, isShellProcess } from './process-tree';
import type { OwnedProcess, ProcessTable } from './process-tree';
import type {
  LiveCall,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from './pi-extension-api';

export { isShellTool, stopNoteText } from '../shared/stop-command';

/** How many live calls are remembered. A run with more than this many *concurrent* calls is not a thing. */
export const LIVE_CALL_LIMIT = 32;

/**
 * How long a process may appear to have started *before* its own `tool_call` and still be it.
 *
 * Needed because the two clocks are not the same clock: the recorded time is `Date.now()` inside pi, while a
 * `ps`-derived start time is an estimate (`now - etime`) and a `/proc` one is boot-relative. Generation order
 * is not at stake — only which of several shells is this one.
 */
export const START_CLOCK_SLACK_MS = 5_000;

/** The one live calls are keyed by: pi's call id, nested ids included (`<parent>/<n>`). */
export type CallId = string;

/**
 * What the bridge knows about the calls it has seen begin and not yet seen finish.
 *
 * The bridge is the only party holding *both* halves of the identification: the `tool_call` event gives it the
 * tool's own command text keyed by call id (which the webview could restate but must not be trusted to), and
 * the same process gives it the shells. So a stop request carries an id and nothing else.
 */
export class StopBoard {
  private readonly live = new Map<CallId, LiveCall>();
  /** callId → the human's note, awaiting the result of the call it stopped. */
  private readonly notes = new Map<CallId, string>();

  /**
   * Remember a call that can be stopped.
   *
   * Only a shell with a string `command` is recorded: anything else is a call with no process, and a card
   * must not offer a button that can only ever fail.
   */
  record(event: ToolCallEvent): void {
    const command = shellCommandOf(event.toolName, event.input);
    if (!command) return;
    if (this.live.size >= LIVE_CALL_LIMIT && !this.live.has(event.toolCallId)) {
      const oldest = this.live.keys().next();
      if (!oldest.done) this.live.delete(oldest.value);
    }
    this.live.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      command,
      parentToolCallId: event.parentToolCallId,
      startedAt: Date.now(),
    });
  }

  of(callId: CallId): LiveCall | undefined {
    return this.live.get(callId);
  }

  /** A call that finished is no longer a thing a stop can mean, and a stale entry is a wrong target. */
  forget(callId: CallId): void {
    this.live.delete(callId);
  }

  /**
   * Promise the note for this call's result. Always called *before* the signal goes out: a command that dies
   * instantly would otherwise have its result pass the hook and be handed to the model unannotated.
   */
  promiseNote(callId: CallId, note: string): void {
    if (this.notes.size >= LIVE_CALL_LIMIT && !this.notes.has(callId)) {
      const oldest = this.notes.keys().next();
      if (!oldest.done) this.notes.delete(oldest.value);
    }
    this.notes.set(callId, note);
  }

  takeNote(callId: CallId): string | undefined {
    const note = this.notes.get(callId);
    if (note !== undefined) this.notes.delete(callId);
    return note;
  }

  /**
   * Forget everything.
   *
   * Called on `session_start`, and on `turn_end`: once a turn has ended, every one of its calls has either
   * produced a result (already forgotten by the hook) or will never produce one, because the run aborted — and
   * pi builds that error result itself, without running the `tool_result` hooks. Anything still on the board at
   * a boundary is therefore a claim about a process that no longer exists, and a stale `startedAt` would widen
   * the aim of the next stop rather than narrow it.
   */
  clear(): void {
    this.live.clear();
    this.notes.clear();
  }

  /** For diagnostics and tests: what the bridge currently believes is running. */
  liveCalls(): LiveCall[] {
    return [...this.live.values()];
  }
}

// --------------------------------------------------------------------------- the note

/**
 * Hand the human's words to the model: the mirror of pi-gate's `attachNote`.
 *
 * Returns `undefined` for every call nobody stopped, which pi reads as "no intervention". Everything else is
 * passed through — pi drops `structuredContent` when a handler replaces `content` without restating it, which
 * would silently cost a bash result its exit code.
 */
export function attachStopNote(
  event: ToolResultEvent,
  board: StopBoard,
): ToolResultEventResult | undefined {
  const note = board.takeNote(event.toolCallId);
  if (note === undefined) return undefined;
  return {
    content: [{ type: 'text', text: stopNoteText(note) }, ...event.content],
    details: event.details,
    isError: event.isError,
    ...(event.usage === undefined ? {} : { usage: event.usage }),
    ...(event.structuredContent === undefined
      ? {}
      : { structuredContent: event.structuredContent }),
  };
}

// --------------------------------------------------------------------------- the aim

export type StopPlan =
  | {
      ok: true;
      target: OwnedProcess;
      /** How sure the aim was, as the wire's `matched`. */
      matched: 'command' | 'single-shell';
      /** How many processes the aim chose between, and how many calls the bridge thought were running. */
      candidates: number;
      liveCalls: number;
    }
  | { ok: false; code: BridgeErrorCode; error: string };

/** Whitespace-folded, so a multiline command still matches a one-line argv rendering of it. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whether this table's start times are wall clock at all (Windows CIM and a baseless `/proc` say no). */
function reportsStartTimes(table: ProcessTable): boolean {
  return table.timeBase === 'epoch';
}

function refusal(code: BridgeErrorCode, error: string): StopPlan {
  return { ok: false, code, error };
}

/**
 * Which process is this call?
 *
 * The command text decides whenever it can: pi passes it as one argv element of the shell it spawns, so the
 * command line of whatever that shell became contains it — and it usually *does* become something else, because
 * bash replaces itself for a single simple command, so `bash -c "make world"` is a process called `make` with
 * nobody left in it named bash. Requiring a shell here would fail on exactly the commands this feature exists
 * for. What restricts the search instead is the *parent*: only a process this child spawned can be one of its
 * tool calls' processes. Age narrows that set when the table has a wall clock to compare against, and is skipped
 * when it does not (`timeBase: 'none'`), because a wrong clock must never talk itself into refusing the command
 * in front of the human — the text is the identification, the age is a tie-breaker.
 *
 * Only when the text finds nothing — another extension rewrote `input.command` after this hook ran, a
 * `commandPrefix` got prepended in a way that broke the match — does the bridge consider the one process it can
 * blame, and only when this call is the *only* one the bridge believes is running. That last condition is what
 * makes the fallback safe: pi executes a batch's calls concurrently, so two live calls means two plausible owners
 * of a shell, and killing the wrong one is the harm this file exists to avoid. `matched: 'single-shell'` then
 * reports the guess on the wire instead of hiding it.
 */
export function planStop(
  call: LiveCall,
  table: ProcessTable,
  liveCalls = 1,
): StopPlan {
  if (table.error) {
    return refusal(
      'unsupported',
      `this runtime cannot see its own child processes (${table.error}).`,
    );
  }
  const kids = childrenOf(table);
  if (!kids.length) {
    return refusal(
      'no-process',
      'nothing is running in this child — that command has already ended.',
    );
  }
  const pool = reportsStartTimes(table)
    ? kids.filter(
        (info) => info.startedAt >= call.startedAt - START_CLOCK_SLACK_MS,
      )
    : kids;
  if (!pool.length) {
    // Every process this child owns predates the call, so none of them can be it. Reaching for one of them
    // would kill somebody else's command, which is the one harm this file can do.
    return refusal(
      'no-process',
      'no process this child owns began as late as that call — it has probably already ended.',
    );
  }
  const needle = collapse(call.command);
  const exact =
    needle.length >= 2
      ? pool.filter((info) => collapse(info.cmdline).includes(needle))
      : [];
  if (exact.length === 1) {
    return {
      ok: true,
      target: exact[0] as OwnedProcess,
      matched: 'command',
      candidates: pool.length,
      liveCalls,
    };
  }
  if (exact.length > 1) {
    // Two identical commands at once, from a concurrent batch. The oldest is the one that has been hanging
    // longest, which is the one the human is looking at.
    const oldest = [...exact].sort(
      (a, b) => a.startedAt - b.startedAt,
    )[0] as OwnedProcess;
    return {
      ok: true,
      target: oldest,
      matched: 'command',
      candidates: exact.length,
      liveCalls,
    };
  }
  // Nothing carries the command text. Consider what could plausibly be it — a shell still interpreting a script,
  // or a process that at least began as the same program — and stop unless exactly one qualifies *and* exactly
  // one call is live.
  const program = needle.split(' ')[0] ?? '';
  const likely = pool.filter(
    (info) =>
      isShellProcess(info) ||
      collapse(info.cmdline).split(' ').includes(program),
  );
  if (likely.length === 1 && liveCalls === 1) {
    return {
      ok: true,
      target: likely[0] as OwnedProcess,
      matched: 'single-shell',
      candidates: 1,
      liveCalls,
    };
  }
  if (likely.length === 1) {
    return refusal(
      'no-process',
      `no process carries that command's text, and ${liveCalls} calls are running at once — the only shell this child has could belong to any of them. Use Abort turn instead.`,
    );
  }
  return refusal(
    'no-process',
    `none of the ${pool.length} processes this child is running matches that command — it may have moved on. Use Abort turn instead.`,
  );
}

/** The human-readable summary of an executed stop, for the output channel and a future toast. */
export function describeStop(
  matched: 'command' | 'single-shell',
  outcome: { pids: number[]; group: boolean; signals: string[] },
): string {
  const how = outcome.signals.length
    ? outcome.signals.join(' then ')
    : 'already gone';
  const aim =
    matched === 'command'
      ? 'matched the command'
      : 'was the only command this child was running';
  return `${how} ${outcome.group ? 'process group' : 'process'} ${outcome.pids.join(', ')} (${aim})`;
}
