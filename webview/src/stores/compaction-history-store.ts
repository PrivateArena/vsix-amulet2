import { create } from 'zustand';
import type {
  CompactionBoundary,
  CompactionDetail,
  HostMessage,
} from '../../../shared/protocol';
import { actions } from '../apis/actions';

/**
 * The compaction history of the session the runtime has loaded.
 *
 * It is a cache, not chat state: the transcript never reads it (a boundary is not a message, and
 * pi's projection of one is stripped host-side), and its summaries are kilobytes each that only
 * matter to whoever opens them. So the list is asked for when the button is hovered and a summary
 * when one of its rows is clicked — never with the history snapshot. The answers arrive through
 * the shell, the same way `projectFiles` does.
 */
interface CompactionHistoryState {
  /** Boundaries of the branch, newest first. */
  boundaries: CompactionBoundary[];
  /** The session file `boundaries` describes; null until an answer lands. */
  sessionFile: string | null;
  /** Id of the list request whose answer is still expected, or null when settled. */
  requestId: number | null;
  /** When the current list was accepted, so an empty session reads as empty rather than loading. */
  loadedAt: number;
  /** Boundary the dialog shows, or null while it is closed. */
  openId: string | null;
  /** Summary of `openId`, or null while it is on its way / absent. */
  detail: CompactionDetail | null;
  /** The host had no such entry: the list is older than the session file. */
  detailMissing: boolean;
  /** Pull the list, unless an answer is already on its way. */
  refresh: () => void;
  /** Fold in a list answer; anything not the request we are waiting for is dropped. */
  acceptList: (message: Extract<HostMessage, { type: 'compactions' }>) => void;
  /** Show one boundary, fetching its summary. */
  open: (id: string) => void;
  close: () => void;
  /** Fold in a summary answer; one for a boundary the dialog has moved past is dropped. */
  acceptDetail: (id: string, detail: CompactionDetail | null) => void;
}

/** Ids only ever compare to themselves, so a monotonic counter is enough. */
let requestSeq = 0;

export const useCompactionHistoryStore = create<CompactionHistoryState>(
  (set, get) => ({
    boundaries: [],
    sessionFile: null,
    requestId: null,
    loadedAt: 0,
    openId: null,
    detail: null,
    detailMissing: false,

    refresh: () => {
      if (get().requestId !== null) return;
      const requestId = ++requestSeq;
      set({ requestId });
      actions.requestCompactions(requestId);
    },

    acceptList: (message) => {
      const { requestId } = get();
      if (requestId !== null && message.requestId !== requestId) return;
      set({
        requestId: null,
        boundaries: message.boundaries,
        sessionFile: message.sessionFile,
        loadedAt: Date.now(),
      });
    },

    open: (id) => {
      set({
        openId: id,
        detail: null,
        detailMissing: false,
      });
      actions.requestCompactionDetail(id);
    },

    close: () => set({ openId: null, detail: null, detailMissing: false }),

    acceptDetail: (id, detail) => {
      // A summary for the boundary we closed, or switched away from, is not the one on screen.
      if (get().openId !== id) return;
      set({ detail, detailMissing: !detail });
    },
  }),
);

export const compactionHistory = {
  refresh: (): void => useCompactionHistoryStore.getState().refresh(),
  open: (id: string): void => useCompactionHistoryStore.getState().open(id),
  close: (): void => useCompactionHistoryStore.getState().close(),
};
