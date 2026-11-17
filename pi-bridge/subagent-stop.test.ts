/**
 * The client half of the subagent stop: reading a registry that another extension owns.
 *
 * What is worth testing is exactly what cannot be seen from pi-subagent's own suite — that the bridge calls
 * nothing it did not verify, and that a refusal keeps the two "no" answers apart. The symbol is a shared *name*,
 * not a capability: anything in the process could occupy it, so the version and the shape are checked before a
 * click is ever turned into an `abort()` on somebody's child.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SUBAGENT_STOP_API_VERSION,
  SUBAGENT_STOP_KEY,
  describeSubagentStopFailure,
  readSubagentStopApi,
  subagentStopPublished,
} from './subagent-stop';

function apiShack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: SUBAGENT_STOP_API_VERSION,
    running: () => [],
    stop: async () => ({ ok: true, callId: 'call_1', role: 'explore', asked: false }),
    ...over,
  };
}

const host = (value: unknown): Record<symbol, unknown> => ({
  [SUBAGENT_STOP_KEY]: value,
});

describe('readSubagentStopApi', () => {
  it('reads the name pi-subagent publishes under', () => {
    // The one assertion that crosses the repository boundary: the well-known symbol's string is the whole
    // contract, and a rename on either side is a silent "no stop API here" forever.
    expect(SUBAGENT_STOP_KEY).toBe(Symbol.for('pi-subagent.stop'));
  });

  it('returns nothing when no subagent extension is loaded', () => {
    expect(readSubagentStopApi({})).toBeUndefined();
    expect(subagentStopPublished({})).toBe(false);
  });

  it('refuses an object that occupies the name but is not the API', () => {
    expect(readSubagentStopApi(host(undefined))).toBeUndefined();
    expect(readSubagentStopApi(host(null))).toBeUndefined();
    expect(readSubagentStopApi(host('pi-subagent.stop'))).toBeUndefined();
    expect(readSubagentStopApi(host({}))).toBeUndefined();
    // A second copy of the extension, or a future one with a different `stop` signature: refused, not called.
    expect(
      readSubagentStopApi(host(apiShack({ version: SUBAGENT_STOP_API_VERSION + 1 }))),
    ).toBeUndefined();
    expect(readSubagentStopApi(host(apiShack({ stop: 'call' })))).toBeUndefined();
    expect(readSubagentStopApi(host(apiShack({ running: undefined })))).toBeUndefined();
    expect(subagentStopPublished(host(apiShack({ version: 0 })))).toBe(false);
  });

  it('hands back the live object, so `stop` reaches the run rather than a copy', async () => {
    const stop = vi.fn(async () => ({
      ok: true as const,
      callId: 'c',
      role: 'review',
      asked: false,
    }));
    const api = readSubagentStopApi(host(apiShack({ stop })));
    await expect(
      api?.stop({ callId: 'call_9', reason: 'note', answered: true }),
    ).resolves.toEqual({ ok: true, callId: 'c', role: 'review', asked: false });
    // The whole request travels as one object, `answered` included: a mirror that dropped the flag would turn
    // every Amulet click into a second dialog in front of a person who has just answered.
    expect(stop).toHaveBeenCalledWith({
      callId: 'call_9',
      reason: 'note',
      answered: true,
    });
  });
});

describe('describeSubagentStopFailure', () => {
  it('calls a finished run "not running", in the code the host already knows', () => {
    const refusal = describeSubagentStopFailure({
      ok: false,
      code: 'no-run',
      error: 'no subagent is running in this session.',
    });
    expect(refusal.code).toBe('not-running');
    // The human needs the way out, not just the negation: this is the click that was meant to end a hang.
    expect(refusal.error).toContain('Abort turn');
  });

  it('calls a wrong address an unknown handle, and never retries against whatever is running', () => {
    const refusal = describeSubagentStopFailure({
      ok: false,
      code: 'unknown-call',
      error: 'call call_1 is not the subagent that is running (this one is: explore call_2).',
    });
    expect(refusal.code).toBe('unknown-handle');
    expect(refusal.error).toContain('call_2');
  });

  it('says so when the child was asked and nobody said yes', () => {
    // The one refusal where the run is still going: the card must not read as stopped, and the human is
    // allowed to press again.
    const refusal = describeSubagentStopFailure({
      ok: false,
      code: 'not-answered',
      error: 'the explore subagent kept running — stopping it was not answered yes.',
    });
    expect(refusal.code).toBe('not-answered');
    expect(refusal.error).toContain('still running');
  });
});
