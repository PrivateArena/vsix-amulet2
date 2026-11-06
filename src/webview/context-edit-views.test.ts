import { describe, expect, it } from 'vitest';
import type { ContextEditView } from '../../shared/protocol';
import { AppliedEditStore } from './context-edit-views';

/**
 * The provisional half of the badge list: what this host asked the bridge for, before the session file
 * records it. Two properties matter, and both are about time rather than content — a claim that outlives
 * its proof is how a card ends up lying about a conversation.
 */

const view = (over: Partial<ContextEditView> = {}): ContextEditView => ({
  entryId: 'tr1',
  toolCallId: 'call_1',
  kind: 'omitted',
  originalText: '',
  ...over,
});

const FILE = '/sessions/a.jsonl';

describe('AppliedEditStore', () => {
  it('adds an accepted edit until the durable list states it', () => {
    const store = new AppliedEditStore();
    store.remember(FILE, view());

    expect(store.merge(FILE, [])).toEqual([view()]);
    // The file now says the same thing, so the provisional claim is redundant and retires itself.
    const durable = [view({ kind: 'omitted', originalText: 'the output' })];
    expect(store.merge(FILE, durable)).toEqual(durable);
    expect(store.merge(FILE, durable)).toEqual(durable);
  });

  it('keeps claims per session file', () => {
    // Entry ids are 8 hex chars per session: a badge of the session the user switched away from must not
    // land on a card of the one they switched into.
    const store = new AppliedEditStore();
    store.remember(FILE, view());
    expect(store.merge('/sessions/b.jsonl', [])).toEqual([]);
    expect(store.merge(FILE, [])).toHaveLength(1);
  });

  it('drops a claim when the card is restored', () => {
    const store = new AppliedEditStore();
    store.remember(FILE, view());
    store.forget(FILE, 'call_1');
    // A restore is a durable no-op edit, which the reader skips, so nothing would ever have cleared it.
    expect(store.merge(FILE, [])).toEqual([]);
  });

  it('forgets nothing when the key belongs to another card', () => {
    const store = new AppliedEditStore();
    store.remember(FILE, view());
    store.forget(FILE, 'call_other', undefined);
    expect(store.merge(FILE, [])).toHaveLength(1);
  });

  it('posts a refusal exactly once', () => {
    const store = new AppliedEditStore();
    store.remember(
      FILE,
      view({
        kind: 'failed',
        error: 'pi is working; wait for the run to finish',
      }),
      false,
    );
    const first = store.merge(FILE, []);
    expect(first.map((v) => v.kind)).toEqual(['failed']);
    // The second push must not repeat it: a transient refusal painted onto a card forever is its own lie.
    expect(store.merge(FILE, [])).toEqual([]);
  });

  it('ignores an edit it cannot attribute to a session', () => {
    const store = new AppliedEditStore();
    store.remember(null, view());
    expect(store.merge(null, [view({ entryId: 'durable' })])).toEqual([
      view({ entryId: 'durable' }),
    ]);
  });

  it('stays bounded across many sessions', () => {
    const store = new AppliedEditStore(2);
    for (const file of ['/a.jsonl', '/b.jsonl', '/c.jsonl']) {
      store.remember(file, view());
    }
    // The oldest session's claims are gone; the newest two are not.
    expect(store.merge('/a.jsonl', [])).toEqual([]);
    expect(store.merge('/c.jsonl', [])).toHaveLength(1);
  });
});
