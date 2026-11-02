import { create } from 'zustand';
import type { ProjectFilesResult } from '../../../shared/protocol';
import { actions } from '../apis/actions';

/**
 * The project file listing behind `@`-mentions.
 *
 * It is a cache, not chat state: the transcript never reads it, and the host throttles the
 * scan. So it lives beside `composer-store` rather than in the reducer, and the answer
 * arrives through the shell the same way `pickedFiles` does.
 */
interface ProjectFilesState {
  /** Paths from the last accepted listing, relative to `cwd`. */
  paths: string[];
  /** Directory the listing describes — shown in the menu so the scope is never a guess. */
  cwd: string;
  /** Id of the request whose answer is still expected, or null when settled. */
  requestId: number | null;
  /** When the last accepted listing landed; 0 until one does. */
  receivedAt: number;
  /** The host stopped at its scan cap, so absence is not proof of absence. */
  truncated: boolean;
  /** Why the listing is missing, when the host said so. */
  error?: string;
  /** Ask for a listing, `force` past both caches. */
  request: (force?: boolean) => void;
  /** Fold in an answer; anything not the request we are waiting for is dropped. */
  accept: (result: ProjectFilesResult) => void;
}

/**
 * How long the webview treats its copy as good. The host caches too, but a listing is
 * hundreds of kilobytes and re-opening the menu must not pay for that again.
 */
const LISTING_TTL_MS = 10_000;

/** A bridge that never answers (disposed, reload mid-request) must not lock the cache. */
const ANSWER_TIMEOUT_MS = 8_000;

/** Ids only ever compare to themselves, so a monotonic counter is enough. */
let requestSeq = 0;

/** Set while an answer is expected, so an expired one cannot leave the cache "loading". */
let answerTimer: ReturnType<typeof setTimeout> | undefined;

function clearAnswerTimer() {
  if (answerTimer) clearTimeout(answerTimer);
  answerTimer = undefined;
}

export const useProjectFilesStore = create<ProjectFilesState>((set, get) => ({
  paths: [],
  cwd: '',
  requestId: null,
  receivedAt: 0,
  truncated: false,
  request: (force) => {
    const { requestId, receivedAt } = get();
    if (requestId !== null) return; // an answer is already on its way
    if (!force && Date.now() - receivedAt < LISTING_TTL_MS) return;
    const id = ++requestSeq;
    set({ requestId: id });
    actions.requestProjectFiles(id, force);
    clearAnswerTimer();
    answerTimer = setTimeout(() => {
      if (get().requestId !== id) return;
      clearAnswerTimer();
      // Give the id up, or a lost answer would read as "still loading" forever and the
      // menu could never ask again. The listing we already have stays usable.
      set({
        requestId: null,
        error: 'The file listing did not answer in time',
      });
    }, ANSWER_TIMEOUT_MS);
  },
  accept: (result) => {
    // One answer belongs to the outstanding request. Everything else — another surface's
    // reply, or a late one for a listing this webview already gave up on — is dropped, or
    // it would overwrite a newer tree with an older one.
    if (get().requestId !== result.requestId) return;
    clearAnswerTimer();
    set({
      paths: result.paths,
      cwd: result.cwd,
      requestId: null,
      receivedAt: Date.now(),
      truncated: result.truncated,
      error: result.error,
    });
  },
}));

/** Module-level facade so hooks and the shell can drive the cache without subscribing. */
export const projectFiles = {
  request: (force?: boolean) => useProjectFilesStore.getState().request(force),
  accept: (result: ProjectFilesResult) =>
    useProjectFilesStore.getState().accept(result),
};
