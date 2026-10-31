import { create } from 'zustand';

interface SessionInfoStore {
  open: boolean;
  openDialog: () => void;
  close: () => void;
}

/** Visibility of the "Show session info" dialog; its data lives in the chat store. */
export const useSessionInfoStore = create<SessionInfoStore>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openSessionInfo = (): void =>
  useSessionInfoStore.getState().openDialog();
