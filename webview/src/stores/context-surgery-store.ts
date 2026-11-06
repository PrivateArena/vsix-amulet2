import { create } from 'zustand';
import type { BridgeOp } from '../../../shared/bridge-protocol';
import type { RevertResult } from '../../../shared/protocol';

/**
 * The transient UI state of context surgery: which card is waiting on an operation, and whether a
 * revert can still be undone.
 *
 * Deliberately nothing else. The badges themselves — what the model may or may not re-read — are chat
 * state and live in the reducer (`ChatState.ctxEdits`, `ToolExec.ctxEdit`, `ChatState.bridge`,
 * `ChatState.lastRevert`); this store holds only what must survive a re-render and must never be
 * trusted as an answer, because the host can push a list that contradicts it at any moment. That is
 * also why an in-flight row is keyed here and not in a card's own state: the reply is a `contextEdits`
 * push, so the view clears it (`setInFlight(id)`, no op) when the list that proves the edit lands —
 * and clears it on a failure too, since a badge of `failed` is what the list carries then.
 */
export interface ContextSurgeryState {
  /** Op this surface asked for and has no proof of yet, by tool call id. */
  inFlight: Record<string, BridgeOp | undefined>;
  /**
   * The revert this surface may still take back, or null while no offer is live. The transcript row
   * is the host's `notice`; this is only what the panel needs to render the way back.
   */
  undoRevert: RevertResult | null;
  /** Mark a card as waiting, or (with no op) as settled — the caller owns both moments. */
  setInFlight(toolCallId: string, op?: BridgeOp): void;
  setUndoRevert(v: RevertResult | null): void;
  /** Drop every in-flight mark: the edit list that just landed is the proof they were waiting for. */
  clearInFlight(): void;
  /** Drop everything: a session switch or a runtime restart makes both meaningless. */
  clearAll(): void;
}

export const useContextSurgeryStore = create<ContextSurgeryState>((set) => ({
  inFlight: {},
  undoRevert: null,

  setInFlight: (toolCallId, op) =>
    set((state) => {
      if (state.inFlight[toolCallId] === op) return state;
      const next = { ...state.inFlight };
      if (op) next[toolCallId] = op;
      // Deleted rather than undefined: a card that is not waiting must not read as a key that is.
      else delete next[toolCallId];
      return { inFlight: next };
    }),

  clearInFlight: () =>
    set((state) =>
      // The same no-wake rule as `setInFlight`: the edit list is pushed after every history snapshot,
      // and a store that returns a new object every time would re-render every card on every push.
      Object.keys(state.inFlight).length ? { inFlight: {} } : state,
    ),

  setUndoRevert: (v) => set({ undoRevert: v }),

  clearAll: () => set({ inFlight: {}, undoRevert: null }),
}));

export const contextSurgery = {
  setInFlight: (toolCallId: string, op?: BridgeOp): void =>
    useContextSurgeryStore.getState().setInFlight(toolCallId, op),
  setUndoRevert: (result: RevertResult | null): void =>
    useContextSurgeryStore.getState().setUndoRevert(result),
  clearInFlight: (): void => useContextSurgeryStore.getState().clearInFlight(),
  clearAll: (): void => useContextSurgeryStore.getState().clearAll(),
};
