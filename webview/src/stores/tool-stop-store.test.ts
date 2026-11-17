/**
 * The store behind "Stopping…" and behind a refusal that stays on the card.
 *
 * Its whole job is to be right about one thing: a card is waiting *until the bridge answers*, and never
 * otherwise. Both failure modes are user-visible — a control stuck on "Stopping…" reads as a broken button, and
 * a refusal that vanished reads as a click that did nothing, which is what this feature was reported as.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useToolStopStore, toolStop } from './tool-stop-store';

const fresh = () => {
  useToolStopStore.setState({ inFlight: {}, refusals: {} });
  return useToolStopStore.getState();
};

beforeEach(fresh);

describe('in-flight marks', () => {
  it('marks the call the stop was asked for, and nothing else', () => {
    toolStop.setInFlight('call_1', 'command');
    const state = useToolStopStore.getState();
    expect(state.inFlight.call_1).toBe('command');
    expect('call_2' in state.inFlight).toBe(false);
  });

  it('answers a mark with the ack, so no timer has to guess how long a kill takes', () => {
    toolStop.setInFlight('call_1', 'run');
    toolStop.settle('call_1');
    const state = useToolStopStore.getState();
    // Deleted, not undefined: `inFlight[id] !== undefined` is what the gate reads.
    expect('call_1' in state.inFlight).toBe(false);
  });

  it('keeps two surfaces honest on one call id', () => {
    // The card header and the nested row render the same control; the store is what makes them agree.
    toolStop.setInFlight('call_1/3', 'command');
    expect(useToolStopStore.getState().inFlight['call_1/3']).toBe('command');
    toolStop.setInFlight('call_9', 'run');
    toolStop.settle('call_1/3');
    expect(Object.keys(useToolStopStore.getState().inFlight)).toEqual(['call_9']);
  });
});

describe('refusals', () => {
  it('keeps the bridge’s sentence until the human presses again', () => {
    toolStop.setInFlight('call_1', 'command');
    toolStop.settle('call_1', {
      kind: 'command',
      error: 'none of the 4 processes this child is running matches that command',
    });
    const state = useToolStopStore.getState();
    expect(state.refusals.call_1?.error).toContain('matches that command');
    expect('call_1' in state.inFlight).toBe(false);

    // A re-press is a new question: the old refusal must not tint the control while the new one is in flight.
    toolStop.setInFlight('call_1', 'command');
    expect(useToolStopStore.getState().refusals.call_1).toBeUndefined();
  });

  it('tells the two levers apart, because a card can offer only one of them', () => {
    toolStop.settle('call_1', { kind: 'run', error: 'no subagent is running.' });
    expect(useToolStopStore.getState().refusals.call_1?.kind).toBe('run');
  });

  it('clears a refusal when the same call finally stops', () => {
    toolStop.settle('call_1', { kind: 'command', error: 'try again' });
    toolStop.settle('call_1');
    expect('call_1' in useToolStopStore.getState().refusals).toBe(false);
  });
});

describe('clearAll', () => {
  it('forgets everything on a session switch', () => {
    toolStop.setInFlight('call_1', 'command');
    toolStop.settle('call_2', { kind: 'command', error: 'x' });
    toolStop.clearAll();
    const state = useToolStopStore.getState();
    expect(state.inFlight).toEqual({});
    expect(state.refusals).toEqual({});
  });

  it('does not wake a subscriber when there was nothing to forget', () => {
    // `clearAll` runs on every session switch and every restart; a fresh object each time re-renders the
    // whole transcript for no reason (the same no-wake rule `context-surgery-store.ts` follows).
    const before = useToolStopStore.getState();
    toolStop.clearAll();
    expect(useToolStopStore.getState()).toBe(before);
  });
});
