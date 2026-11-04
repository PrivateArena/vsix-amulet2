import { create } from 'zustand';
import type {
  HostMessage,
  PackageListResult,
  PackageOpResult,
  PackageOperation,
  PackageScope,
} from '../../../shared/protocol';
import { actions } from '../apis/actions';

/**
 * The Packages dialog: its visibility, its host-backed rows, and the operation in flight.
 *
 * The list is a cache, not chat state — the transcript never reads it, and it is only ever correct
 * for the settings files as they were when it was asked for. So nothing is fetched until the dialog
 * opens (or an operation finishes), and every request carries an id that its answer must match: a
 * listing that arrives after a workspace-folder switch belongs to a different pair of settings files
 * and must be dropped, the same rule `compaction-history-store` follows.
 *
 * Two of the five operations are instant (enable/disable, a settings-file write) and two are slow
 * (install/remove, a `pi` child process that may sit on npm for minutes), which is why the store
 * tracks one busy operation rather than a loading flag.
 */
export type PackagesTab = 'installed' | 'discover';

export interface PackagesState {
  open: boolean;
  tab: PackagesTab;
  /** Whether the "install from source" form is open under the tab bar. */
  installOpen: boolean;
  /** Last accepted listing, or null until the first answer lands. */
  list: PackageListResult | null;
  /** Id of the listing whose answer is still expected, or null when settled. */
  requestId: number | null;
  /**
   * Operation whose result has not arrived yet, addressed by the id this store minted for it.
   * {@link scope}/{@link index} name the row that asked, so only that row spins — a source declared in
   * both scopes is two rows, and only one of them was clicked.
   */
  busy: {
    opId: number;
    op: PackageOperation;
    source: string;
    scope?: PackageScope;
    index?: number;
  } | null;
  /** Outcome of the last operation, kept until the next one so a failure stays readable. */
  lastOp: PackageOpResult | null;

  openDialog: () => void;
  close: () => void;
  setTab: (tab: PackagesTab) => void;
  setInstallOpen: (open: boolean) => void;
  /** Ask for the list, unless an answer is already on its way. */
  refresh: () => void;
  /** Fold in a listing; one that is not the request we are waiting for is dropped. */
  acceptList: (message: Extract<HostMessage, { type: 'packages' }>) => void;
  /** Fold in an operation result and re-read the files it may have changed. */
  acceptOp: (result: PackageOpResult) => void;

  install: (source: string, scope: PackageScope) => void;
  remove: (source: string, index: number, scope: PackageScope) => void;
  /** Toggle the declaration sitting at {@link index} in {@link scope}'s settings file. */
  setEnabled: (
    source: string,
    index: number,
    scope: PackageScope,
    enabled: boolean,
  ) => void;
  /** Kill the `pi install`/`pi remove` child. */
  cancel: () => void;
  /** Restart the runtimes so they load what the settings files now declare. */
  reload: () => void;
}

/** Ids only ever compare to themselves, so a monotonic counter is enough — for listings and for ops. */
let requestSeq = 0;
let opSeq = 0;

export const usePackagesStore = create<PackagesState>((set, get) => ({
  open: false,
  tab: 'installed',
  installOpen: false,
  list: null,
  requestId: null,
  busy: null,
  lastOp: null,

  openDialog: () => {
    // A fresh open is a fresh read: the settings files may have moved since last time (a `pi
    // install` in a terminal is the normal way that happens). The last result survives, because an
    // install that failed while the dialog was closed is still the answer to what the human asked for.
    set({ open: true, tab: 'installed', installOpen: false });
    get().refresh();
  },

  close: () => set({ open: false, installOpen: false }),

  setTab: (tab) => set({ tab }),

  setInstallOpen: (installOpen) => set({ installOpen }),

  /**
   * Ask for the list. Unconditional on purpose: an answer already on its way may have been read
   * before the operation that just finished, and {@link acceptList} drops the mismatched id, so
   * issuing a second request is what makes the newest file state the one on screen.
   */
  refresh: () => {
    const requestId = ++requestSeq;
    set({ requestId });
    actions.requestPackages(requestId);
  },

  acceptList: (message) => {
    const { requestId } = get();
    if (requestId !== null && message.result.requestId !== requestId) return;
    set({ requestId: null, list: message.result });
  },

  acceptOp: (result) => {
    // One operation at a time, but the answer must still be recognised: a result for an operation this
    // store no longer waits for (its cancel raced a close, a reload answered late) would otherwise
    // clear the spinner of the op that is really still running, and show the wrong alert.
    const { busy } = get();
    if (busy && busy.opId !== result.opId) return;
    set({ busy: null, lastOp: result });
    get().refresh();
  },

  install: (source, scope) => {
    const opId = ++opSeq;
    set({
      busy: { opId, op: 'install', source, scope, index: -1 },
      lastOp: null,
    });
    actions.installPackage(opId, source, scope);
  },

  remove: (source, index, scope) => {
    const opId = ++opSeq;
    set({
      busy: { opId, op: 'remove', source, scope, index },
      lastOp: null,
    });
    actions.removePackage(opId, source, scope);
  },

  setEnabled: (source, index, scope, enabled) => {
    const opId = ++opSeq;
    set({
      busy: {
        opId,
        op: enabled ? 'enable' : 'disable',
        source,
        scope,
        index,
      },
      lastOp: null,
    });
    actions.setPackageEnabled(opId, source, index, scope, enabled);
  },

  cancel: () => actions.cancelPackageOperation(),

  reload: () => {
    const opId = ++opSeq;
    set({ busy: { opId, op: 'reload', source: '' }, lastOp: null });
    actions.reloadPackages(opId);
  },
}));

export const openPackages = (): void =>
  usePackagesStore.getState().openDialog();
