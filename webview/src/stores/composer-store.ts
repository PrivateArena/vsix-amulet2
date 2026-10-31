import { create } from 'zustand';

/**
 * Imperative handle the composer publishes so host-driven commands
 * (`amulet.addFileToChat`, `amulet.focusInput`, `amulet.editMessage`) can drive
 * the draft. The composer owns its own input state, so the shell can't set it
 * directly — it goes through here.
 */
export interface ComposerApi {
  /** Append to the current draft, keeping whatever the user already typed. */
  insertText: (text: string) => void;
  /** Replace the draft outright (fork mode reloads a previous message). */
  setText: (text: string) => void;
  focus: () => void;
}

type ComposerOp = (api: ComposerApi) => void;

interface ComposerStore {
  api: ComposerApi | null;
  /**
   * Ops that arrived before the composer mounted. A right-click "Add File to
   * Chat" on a cold window activates the extension, so the first `insertText`
   * can land while the splash screen is still up and no composer exists yet.
   */
  pending: ComposerOp[];
  register: (api: ComposerApi) => () => void;
  run: (op: ComposerOp) => void;
}

/** Bounded so a webview that never mounts a composer can't grow this forever. */
const MAX_PENDING = 32;

export const useComposerStore = create<ComposerStore>((set, get) => ({
  api: null,
  pending: [],
  register: (api) => {
    const queued = get().pending;
    set({ api, pending: [] });
    for (const op of queued) op(api);
    return () => {
      if (get().api === api) set({ api: null });
    };
  },
  run: (op) => {
    const api = get().api;
    if (api) {
      op(api);
      return;
    }
    set((s) => ({ pending: [...s.pending, op].slice(-MAX_PENDING) }));
  },
}));

/** Module-level facade so non-component code can drive the composer. */
export const composer = {
  insertText: (text: string) =>
    useComposerStore.getState().run((api) => api.insertText(text)),
  setText: (text: string) =>
    useComposerStore.getState().run((api) => api.setText(text)),
  focus: () => useComposerStore.getState().run((api) => api.focus()),
};
