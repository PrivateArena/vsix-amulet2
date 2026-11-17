import { create } from 'zustand';

/**
 * The transient UI state of the two Stop buttons: which card is waiting on the bridge, and what the bridge
 * answered when it refused.
 *
 * Deliberately nothing else. Whether a call is *running* is chat state (`ToolExec.status`), and the note a
 * stopped command leaves behind is already in that call's result — this holds only what the card cannot derive
 * from the transcript, which is the ack. That is what the 17 s timer it replaced was guessing at: nothing on the
 * wire retires "Stopping…" except the bridge, so the state is keyed by its answer (`toolStopResult`) and no
 * timeout has to be right about a process kill.
 *
 * Keyed by tool call id, like the in-flight marks of `context-surgery-store.ts`, and for the same reason: the
 * two surfaces a stop can be pressed from (a card header, a subagent's nested row) share one control component,
 * and the ack is addressed to the call, not to the surface that asked.
 */
export type StopKind = 'command' | 'run';

/** Why the runtime would not stop that call, in the bridge's own sentence. */
export interface StopRefusal {
  kind: StopKind;
  error: string;
}

export interface ToolStopState {
  /** The stop this surface asked for and has no answer to yet, by tool call id. */
  inFlight: Record<string, StopKind | undefined>;
  /** The refusal that came back, by tool call id — visible until the human presses again. */
  refusals: Record<string, StopRefusal | undefined>;
  /** Mark a call as waiting, and (with no kind) as answered: the caller owns both moments. */
  setInFlight(toolCallId: string, kind?: StopKind): void;
  /** Record what the bridge answered. `ok` clears any earlier refusal on that call. */
  settle(toolCallId: string, refusal?: StopRefusal): void;
  /** Drop everything: a session switch or a runtime restart makes both meaningless. */
  clearAll(): void;
}

export const useToolStopStore = create<ToolStopState>((set) => ({
  inFlight: {},
  refusals: {},

  setInFlight: (toolCallId, kind) =>
    set((state) => {
      if (state.inFlight[toolCallId] === kind && !state.refusals[toolCallId])
        return state;
      const inFlight = { ...state.inFlight };
      // Deleted rather than undefined: a call that is not waiting must not read as a key that is.
      if (kind) inFlight[toolCallId] = kind;
      else delete inFlight[toolCallId];
      const refusals = state.refusals[toolCallId]
        ? withoutRefusal(state.refusals, toolCallId)
        : state.refusals;
      return { inFlight, refusals };
    }),

  settle: (toolCallId, refusal) =>
    set((state) => {
      const inFlight = { ...state.inFlight };
      delete inFlight[toolCallId];
      const current = state.refusals[toolCallId];
      if (refusal === undefined)
        return current ? { inFlight, refusals: withoutRefusal(state.refusals, toolCallId) } : { inFlight };
      if (current?.kind === refusal.kind && current.error === refusal.error)
        return { inFlight };
      return { inFlight, refusals: { ...state.refusals, [toolCallId]: refusal } };
    }),

  clearAll: () =>
    set((state) =>
      // The no-wake rule of the two setters: these run on every session switch, and a store that returns a
      // fresh object when it changed nothing would re-render every card that reads it.
      Object.keys(state.inFlight).length || Object.keys(state.refusals).length
        ? { inFlight: {}, refusals: {} }
        : state,
    ),
}));

function withoutRefusal(
  refusals: ToolStopState['refusals'],
  toolCallId: string,
): ToolStopState['refusals'] {
  const next = { ...refusals };
  delete next[toolCallId];
  return next;
}

/** Non-component entry point, for the host-message handler. */
export const toolStop = {
  setInFlight: (toolCallId: string, kind?: StopKind): void =>
    useToolStopStore.getState().setInFlight(toolCallId, kind),
  settle: (toolCallId: string, refusal?: StopRefusal): void =>
    useToolStopStore.getState().settle(toolCallId, refusal),
  clearAll: (): void => useToolStopStore.getState().clearAll(),
};
