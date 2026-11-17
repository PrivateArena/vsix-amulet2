/**
 * The mirror of pi-subagent's per-run stop API — the other half of the subagent stop.
 *
 * Why a mirror instead of an import: pi loads every extension as its own module graph, so the Amulet bridge
 * cannot `import` anything from pi-subagent (and must not gain a dependency on it — the bridge loads on every
 * runtime, with or without that package). What the two extensions do share is one process, and `Symbol.for`
 * is the one name space both can reach. pi-subagent publishes the API there at load (`pi-subagent/stop-api.ts`,
 * `SUBAGENT_STOP_KEY`); this file is the client's declared shape of it, in the manner of
 * `pi-extension-api.ts`: types the child really provides, checked at the boundary rather than assumed.
 *
 * What this file owns:
 *  - the version gate. An object under a well-known symbol is a claim, not a fact: a second copy of
 *    pi-subagent, or a future one with a different `stop` signature, must be refused rather than called.
 *  - the mapping onto {@link BridgeErrorCode}, so a refusal that reaches the human says which of the two
 *    "no" answers it is — nothing was running, or that was not the run.
 *
 * It never aborts anything itself: the only lever is the API's `stop`, addressed by the id of the `subagent`
 * tool call the human is looking at. A run that cannot be named cannot be stopped.
 */

import type { BridgeErrorCode } from '../shared/bridge-protocol';

/** Must equal pi-subagent's `SUBAGENT_STOP_KEY` — the same well-known name in both processes' one heap. */
export const SUBAGENT_STOP_KEY: symbol = Symbol.for('pi-subagent.stop');

/** Must equal pi-subagent's `SUBAGENT_STOP_API_VERSION`. */
export const SUBAGENT_STOP_API_VERSION = 1;

/** One child that is executing right now, as its own extension reports it. */
export interface RunningSubagent {
  /** The parent's `subagent` tool call id — the only address `stop` takes. */
  callId: string;
  role: string;
  task: string;
  startedAt: number;
}

export type SubagentStopResult =
  | { ok: true; callId: string; role: string; asked: boolean }
  | { ok: false; code: 'no-run' | 'unknown-call' | 'not-answered'; error: string };

/** A stop request, as the other extension receives it. */
export interface SubagentStopRequest {
  callId: string;
  /** The sentence the parent model will read. Empty is allowed and means "no reason was given". */
  reason: string;
  /**
   * Whether a human has already answered for this stop.
   *
   * True for both of Amulet's controls: the plain button and the reason dialog are an explicit press on a
   * control that says which run it ends, so the person has decided and a second dialog over the same decision
   * would be a question already answered. The flag is not a privilege a client grants itself — a client that
   * stops without asking (a keybinding, a headless driver) must leave it off, and pi-subagent then asks in its
   * own words, in whatever room the session is in.
   */
  answered: boolean;
}

export interface SubagentStopApi {
  version: number;
  running(): RunningSubagent[];
  /** Resolves, because it may put a dialog in front of a person and wait. */
  stop(request: SubagentStopRequest): Promise<SubagentStopResult>;
}

/** Where a host may keep published symbol-keyed registries. */
type StopApiHost = Record<symbol, unknown>;

function isFunction(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

/**
 * The API this process publishes, or undefined when there is nothing trustworthy to call.
 *
 * Every field is checked, because the symbol is a shared name and not a capability: an object that answers
 * the name but not the shape is refused, and the UI then shows no button rather than pressing a stranger's.
 */
export function readSubagentStopApi(
  host: StopApiHost = globalThis as unknown as StopApiHost,
): SubagentStopApi | undefined {
  const published = host[SUBAGENT_STOP_KEY];
  if (!published || typeof published !== 'object') return undefined;
  const api = published as Record<string, unknown>;
  if (api.version !== SUBAGENT_STOP_API_VERSION) return undefined;
  if (!isFunction(api.running) || !isFunction(api.stop)) return undefined;
  return published as SubagentStopApi;
}

/** Whether a stop is possible here at all — the answer the `hello` capability reports. */
export function subagentStopPublished(
  host: StopApiHost = globalThis as unknown as StopApiHost,
): boolean {
  return readSubagentStopApi(host) !== undefined;
}

/** A refusal, in the code the host branches on and the sentence the human reads. */
export interface SubagentStopRefusal {
  code: BridgeErrorCode;
  error: string;
}

/**
 * Why the run could not be stopped, in Amulet's own error vocabulary.
 *
 * `no-run` is `not-running`: the card is showing a call this child is no longer executing, which is the same
 * fact the command stop reports. A wrong id is `unknown-handle`, the code every other operation uses for an
 * address that names nothing — and it is always a refusal, never a fallback to "whatever is running", because
 * stopping a subagent the human did not point at is the harm this whole path exists to avoid. `not-answered`
 * is its own code, because it is the one outcome where the run is still going and the human's answer was the
 * reason: the card must not look stopped, and pressing again is a legitimate thing to do.
 */
export function describeSubagentStopFailure(
  result: Extract<SubagentStopResult, { ok: false }>,
): SubagentStopRefusal {
  if (result.code === 'no-run')
    return {
      code: 'not-running',
      error: `${result.error} It may have reported already — use Abort turn if the run itself is stuck.`,
    };
  if (result.code === 'not-answered')
    return {
      code: 'not-answered',
      error: `${result.error} The subagent is still running.`,
    };
  return { code: 'unknown-handle', error: result.error };
}
