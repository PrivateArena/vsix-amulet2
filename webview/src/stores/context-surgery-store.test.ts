import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevertResult } from '../../../shared/protocol';
import {
  contextSurgery,
  useContextSurgeryStore as useStore,
} from './context-surgery-store';

/** The store is a module singleton, so each case starts from a known state. */
function reset() {
  useStore.setState({ inFlight: {}, undoRevert: null });
}

const revert: RevertResult = {
  ok: true,
  revertedFrom: 'e9',
  abandonedCount: 3,
  message: 'Reverted to that message: 3 entries are out.',
};

describe('context surgery store', () => {
  beforeEach(() => reset());

  it('marks only the row it was asked about, and clears it the same way', () => {
    useStore.getState().setInFlight('t1', 'omit');
    useStore.getState().setInFlight('t2', 'replace');
    expect(useStore.getState().inFlight).toEqual({ t1: 'omit', t2: 'replace' });

    // Cleared by the view layer when the `contextEdits` push proves the edit — or reports it failed.
    useStore.getState().setInFlight('t1');
    expect(useStore.getState().inFlight).toEqual({ t2: 'replace' });
    // Deleted rather than kept as an undefined key: a waiting row is a key, a settled one is not.
    expect('t1' in useStore.getState().inFlight).toBe(false);

    useStore.getState().setInFlight('t2');
    expect(useStore.getState().inFlight).toEqual({});
  });

  it('does not wake a subscriber for a state it already holds', () => {
    const heard = vi.fn();
    const off = useStore.subscribe(heard);

    useStore.getState().setInFlight('t1', 'restore');
    expect(heard).toHaveBeenCalledTimes(1);
    useStore.getState().setInFlight('t1', 'restore');
    expect(heard).toHaveBeenCalledTimes(1);
    useStore.getState().setInFlight('t1');
    expect(heard).toHaveBeenCalledTimes(2);
    useStore.getState().setInFlight('t1');
    expect(heard).toHaveBeenCalledTimes(2);

    off();
  });

  it('holds the revert that can still be undone', () => {
    expect(useStore.getState().undoRevert).toBeNull();
    useStore.getState().setUndoRevert(revert);
    expect(useStore.getState().undoRevert).toEqual(revert);
    // The offer is spent the moment it is used or a new run starts.
    useStore.getState().setUndoRevert(null);
    expect(useStore.getState().undoRevert).toBeNull();
  });

  it('drops everything on a session switch', () => {
    useStore.getState().setInFlight('t1', 'omit');
    useStore.getState().setUndoRevert(revert);
    useStore.getState().clearAll();
    expect(useStore.getState()).toMatchObject({
      inFlight: {},
      undoRevert: null,
    });
  });

  it('answers the imperative helper the way it answers the hook', () => {
    contextSurgery.setInFlight('t1', 'revert');
    contextSurgery.setUndoRevert(revert);
    expect(useStore.getState().inFlight.t1).toBe('revert');
    expect(useStore.getState().undoRevert).toEqual(revert);
    contextSurgery.clearAll();
    expect(useStore.getState().inFlight).toEqual({});
  });
});
