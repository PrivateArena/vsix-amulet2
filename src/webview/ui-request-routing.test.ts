import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODAL_UI_METHODS,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
} from '../../shared/protocol';
import {
  ackUiRequest,
  answerUiRequest,
  armUiRequest,
  beginUiRequest,
  isModalUiMethod,
  isTrackingUiRequest,
  pendingUiRequestCount,
  releaseUiRequest,
  UI_DIALOG_ACK_TIMEOUT_MS,
} from './ui-request-routing';

/** Isolated assertion: the shared map is module state, so ids are torn down explicitly. */
const neverAnswered = {
  fallbackToNative: async () => null as ExtensionUiResponse | null,
  respond: () => {},
  dismiss: () => {},
  log: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Map cap in `ui-request-routing.ts`; the eviction test needs it too. */
const MAX_PENDING = 64;

const request = (id: string): ExtensionUiRequest => ({
  type: 'extension_ui_request',
  id,
  method: 'select',
  title: 'gate',
});

const response = (id: string): ExtensionUiResponse => ({
  type: 'extension_ui_response',
  id,
  value: 'allow',
});

/** A dialog whose native fallback resolves immediately, plus the call log. */
function harness(id: string) {
  const answered: ExtensionUiResponse[] = [];
  const dismissed: string[] = [];
  const logs: string[] = [];
  const deps = {
    // The real native fallback only *returns* the answer; responding is the caller's job, and that split
    // is what the assertions below count on.
    fallbackToNative: vi.fn(async (req: ExtensionUiRequest) => {
      const answer = {
        type: 'extension_ui_response' as const,
        id: req.id,
        value: 'native',
      };
      return answer;
    }),
    respond: (r: ExtensionUiResponse) => answered.push(r),
    dismiss: (dismissedId: string) => dismissed.push(dismissedId),
    log: (text: string) => logs.push(text),
  };
  beginUiRequest(request(id), deps);
  return {
    deps,
    answered,
    dismissed,
    logs,
    async settle() {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('isModalUiMethod', () => {
  it('matches exactly the methods that await an answer', () => {
    for (const method of MODAL_UI_METHODS) {
      expect(isModalUiMethod(method)).toBe(true);
    }
    for (const method of ['notify', 'setStatus', 'setTitle', 'setWidget']) {
      expect(isModalUiMethod(method)).toBe(false);
    }
  });
});

describe('beginUiRequest', () => {
  it('lets the first bridge own a request and rejects the rest', () => {
    const h = harness('dup-1');
    expect(beginUiRequest(request('dup-1'), h.deps)).toBe(false);
    expect(beginUiRequest(request('dup-1b'), h.deps)).toBe(true);
    releaseUiRequest('dup-1');
    releaseUiRequest('dup-1b');
  });

  it('frees the id once the answer went back to the runtime', () => {
    const h = harness('dup-2');
    expect(answerUiRequest('dup-2', response('dup-2'))).toBe(true);
    expect(h.answered).toHaveLength(1);
    // A fresh request with a recycled id is claimable again.
    expect(beginUiRequest(request('dup-2'), h.deps)).toBe(true);
    releaseUiRequest('dup-2');
  });

  it('tracks distinct request ids independently', () => {
    expect(beginUiRequest(request('a-1'), neverAnswered)).toBe(true);
    expect(beginUiRequest(request('b-1'), neverAnswered)).toBe(true);
    expect(beginUiRequest(request('a-1'), neverAnswered)).toBe(false);
    releaseUiRequest('a-1');
    releaseUiRequest('b-1');
  });
});

describe('answerUiRequest', () => {
  it('answers pi once, however many surfaces rendered the dialog', () => {
    const h = harness('race-1');
    armUiRequest('race-1', 2);
    expect(answerUiRequest('race-1', response('race-1'))).toBe(true);
    // The second surface that also showed it is dismissed, not double-answered.
    expect(answerUiRequest('race-1', response('race-1'))).toBe(false);
    expect(h.answered).toHaveLength(1);
    expect(h.dismissed).toEqual(['race-1']);
  });

  it('cancels the native fallback timer once a surface has answered', async () => {
    const h = harness('race-2');
    armUiRequest('race-2', 1);
    answerUiRequest('race-2', response('race-2'));
    vi.advanceTimersByTime(UI_DIALOG_ACK_TIMEOUT_MS + 10);
    await h.settle();
    expect(h.deps.fallbackToNative).not.toHaveBeenCalled();
    expect(h.answered).toHaveLength(1);
  });

  it('ignores answers for requests it never owned', () => {
    const h = harness('unknown');
    releaseUiRequest('unknown');
    expect(answerUiRequest('unknown', response('unknown'))).toBe(false);
    expect(h.answered).toHaveLength(0);
  });
});

describe('ackUiRequest', () => {
  it('a visible surface painting the dialog cancels the native fallback', async () => {
    const h = harness('ack-visible');
    armUiRequest('ack-visible', 1);
    expect(ackUiRequest('ack-visible', true)).toBe(true);
    vi.advanceTimersByTime(UI_DIALOG_ACK_TIMEOUT_MS + 10);
    await h.settle();
    expect(h.deps.fallbackToNative).not.toHaveBeenCalled();
  });

  it('a hidden surface is not proof: the native dialog still takes over', async () => {
    const h = harness('ack-hidden');
    armUiRequest('ack-hidden', 1);
    ackUiRequest('ack-hidden', false);
    vi.advanceTimersByTime(UI_DIALOG_ACK_TIMEOUT_MS + 10);
    await h.settle();
    expect(h.deps.fallbackToNative).toHaveBeenCalledTimes(1);
    expect(h.dismissed).toEqual(['ack-hidden']);
    expect(h.answered.map((r) => r.value)).toEqual(['native']);
  });

  it('drops acks for answered or unknown requests', () => {
    const h = harness('ack-gone');
    armUiRequest('ack-gone', 1);
    expect(answerUiRequest('ack-gone', response('ack-gone'))).toBe(true);
    expect(ackUiRequest('ack-gone', true)).toBe(false);
    expect(ackUiRequest('never-asked', true)).toBe(false);
    expect(h.dismissed).toEqual(['ack-gone']);
  });
});

describe('native fallback', () => {
  it('hands the question to VS Code straight away when no surface accepts it', async () => {
    const h = harness('zero-surfaces');
    armUiRequest('zero-surfaces', 0);
    await h.settle();
    expect(h.deps.fallbackToNative).toHaveBeenCalledTimes(1);
    expect(h.answered.map((r) => r.value)).toEqual(['native']);
  });

  it('takes over when a webview never proves it painted the dialog', async () => {
    const h = harness('dropped-post');
    armUiRequest('dropped-post', 1);
    vi.advanceTimersByTime(UI_DIALOG_ACK_TIMEOUT_MS + 10);
    await h.settle();
    expect(h.deps.fallbackToNative).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => l.includes('nobody painted it'))).toBe(true);
  });

  it('a webview answer arriving during the native dialog is dropped', async () => {
    let resolveNative!: (r: ExtensionUiResponse | null) => void;
    const answered: ExtensionUiResponse[] = [];
    const deps = {
      fallbackToNative: () =>
        new Promise<ExtensionUiResponse | null>((r) => (resolveNative = r)),
      respond: (r: ExtensionUiResponse) => answered.push(r),
      dismiss: () => {},
      log: () => {},
    };
    const r = request('late');
    beginUiRequest(r, deps);
    armUiRequest('late', 0);
    resolveNative({
      type: 'extension_ui_response',
      id: 'late',
      value: 'native',
    });
    await Promise.resolve();
    expect(answerUiRequest('late', response('late'))).toBe(false);
    expect(answered).toHaveLength(1);
  });

  it('cancels the question when the native dialog itself fails', async () => {
    const answered: ExtensionUiResponse[] = [];
    const deps = {
      fallbackToNative: async () => {
        throw new Error('no window');
      },
      respond: (r: ExtensionUiResponse) => answered.push(r),
      dismiss: () => {},
      log: () => {},
    };
    beginUiRequest(request('boom'), deps);
    armUiRequest('boom', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(answered).toEqual([
      { type: 'extension_ui_response', id: 'boom', cancelled: true },
    ]);
  });
});

describe('housekeeping', () => {
  it('evicts the oldest request past the cap, answering it so pi is not left parked', async () => {
    // One short of the cap, because the harness already holds one entry: the 65th claim is what evicts.
    const ids = Array.from({ length: MAX_PENDING - 1 }, (_, i) => `cap-${i}`);
    const h = harness('cap-first');
    for (const id of ids) beginUiRequest(request(id), h.deps);
    expect(pendingUiRequestCount()).toBe(MAX_PENDING);
    // The 65th claim evicts `cap-first` and hands it to the native dialog instead of hanging.
    expect(beginUiRequest(request('cap-new'), h.deps)).toBe(true);
    await h.settle();
    expect(h.deps.fallbackToNative).toHaveBeenCalledTimes(1);
    expect(h.dismissed).toEqual(['cap-first']);
    expect(h.answered).toHaveLength(1);
    expect(beginUiRequest(request('cap-new'), h.deps)).toBe(false);
    expect(isTrackingUiRequest('cap-new')).toBe(true);
    expect(isTrackingUiRequest('cap-first')).toBe(false);
    // The evicted id is free again, so a recycled request id stays trackable.
    expect(beginUiRequest(request('cap-first'), h.deps)).toBe(true);
    for (const id of [...ids, 'cap-new', 'cap-first']) releaseUiRequest(id);
    expect(pendingUiRequestCount()).toBe(0);
  });
});
