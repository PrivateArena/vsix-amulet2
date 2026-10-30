import { create } from 'zustand';

/**
 * Imperative handle the transcript publishes so the topbar's prompt navigator can
 * scroll to one of its turns. The list owns scrolling (it also decides whether to
 * keep hugging the bottom while a reply streams), so the navigator asks it
 * instead of reaching into the DOM.
 */
export interface TranscriptNav {
  /** Reveal the turn that starts with this user message. */
  scrollToTurn: (uid: string) => void;
}

interface TurnNavStore {
  /** uid of the user turn anchored at the top of the transcript, or `null`. */
  activeUid: string | null;
  nav: TranscriptNav | null;
  setActiveUid: (uid: string | null) => void;
  register: (nav: TranscriptNav) => () => void;
}

export const useTurnNavStore = create<TurnNavStore>((set, get) => ({
  activeUid: null,
  nav: null,
  setActiveUid: (uid) => {
    if (get().activeUid === uid) return;
    set({ activeUid: uid });
  },
  register: (nav) => {
    set({ nav });
    return () => {
      if (get().nav === nav) set({ nav: null });
    };
  },
}));

/** Module-level facade so non-component code (the topbar) can drive the list. */
export const transcript = {
  scrollToTurn: (uid: string) =>
    useTurnNavStore.getState().nav?.scrollToTurn(uid),
};
