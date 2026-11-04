import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../../../shared/protocol';

const requestCompactions = vi.fn();
const requestCompactionDetail = vi.fn();

vi.mock('../apis/actions', () => ({
  actions: {
    requestCompactions: (id: number) => requestCompactions(id),
    requestCompactionDetail: (id: string) => requestCompactionDetail(id),
  },
}));

import { useCompactionHistoryStore as useStore } from './compaction-history-store';

/** The store is a module singleton, so each case starts from a known state. */
function reset() {
  useStore.setState({
    boundaries: [],
    sessionFile: null,
    requestId: null,
    loadedAt: 0,
    openId: null,
    detail: null,
    detailMissing: false,
  });
}

const list = (
  requestId: number,
  sessionFile: string | null,
  ids: string[],
): Extract<HostMessage, { type: 'compactions' }> => ({
  type: 'compactions',
  requestId,
  sessionFile,
  boundaries: ids.map((id) => ({
    id,
    timestamp: 1_700_000_000_000,
    tokensBefore: 1000,
    readCount: 0,
    modifiedCount: 0,
    hasSummary: true,
  })),
});

const detail = (id: string) => ({
  id,
  timestamp: 1_700_000_000_000,
  tokensBefore: 1000,
  summary: `summary of ${id}`,
});

describe('compaction history store', () => {
  beforeEach(() => {
    reset();
    requestCompactions.mockClear();
    requestCompactionDetail.mockClear();
  });

  it('asks once per hover and takes the answer it asked for', () => {
    useStore.getState().refresh();
    useStore.getState().refresh();
    // One request while an answer is owed, so a held pointer does not hammer the session file.
    expect(requestCompactions).toHaveBeenCalledTimes(1);

    const requestId = requestCompactions.mock.calls[0][0] as number;
    useStore.getState().acceptList(list(requestId, '/s/a.jsonl', ['c2', 'c1']));

    const { boundaries, sessionFile, requestId: settled } = useStore.getState();
    expect(settled).toBeNull();
    expect(boundaries.map((b) => b.id)).toEqual(['c2', 'c1']);
    expect(sessionFile).toBe('/s/a.jsonl');
  });

  it('drops a list that describes a session switch it can no longer be about', () => {
    useStore.getState().refresh();
    const staleId = requestCompactions.mock.calls[0][0] as number;

    // The first answer never landed (a restart mid-read), so a later hover asks again.
    useStore.setState({ requestId: null });
    useStore.getState().refresh();
    useStore.getState().acceptList(list(staleId, '/s/old.jsonl', ['cX']));
    expect(useStore.getState().boundaries).toEqual([]);

    useStore.getState().acceptList(list(staleId + 1, '/s/new.jsonl', ['c1']));
    expect(useStore.getState().sessionFile).toBe('/s/new.jsonl');
  });

  it('fetches a summary on open and ignores one for a boundary since closed', () => {
    useStore.getState().open('c2');
    expect(requestCompactionDetail).toHaveBeenCalledWith('c2');

    useStore.getState().acceptDetail('c1', detail('c1'));
    expect(useStore.getState().detail).toBeNull();

    useStore.getState().acceptDetail('c2', detail('c2'));
    expect(useStore.getState().detail?.summary).toBe('summary of c2');
    expect(useStore.getState().detailMissing).toBe(false);
  });

  it('says so when the boundary has left the session file', () => {
    useStore.getState().open('c9');
    useStore.getState().acceptDetail('c9', null);
    expect(useStore.getState().detail).toBeNull();
    // Distinct from "still loading": the dialog reads this as a dead row, not a slow one.
    expect(useStore.getState().detailMissing).toBe(true);
  });

  it('clears the summary on close, so a reopen never shows the previous one', () => {
    useStore.getState().open('c1');
    useStore.getState().acceptDetail('c1', detail('c1'));
    useStore.getState().close();
    expect(useStore.getState()).toMatchObject({
      openId: null,
      detail: null,
      detailMissing: false,
    });
  });
});
