import { describe, expect, it } from 'vitest';
import { CONTEXT_OP_LABELS, cardMenuOf, contextOpBlocker } from './card-menu';

/**
 * The enablement rules behind both menus that offer context surgery (the tool card's overflow button
 * and the transcript's right-click menu). They live in one pure function precisely so a refusal cannot
 * differ between the two surfaces — and so the reasons are testable without a DOM.
 */

const ok = {
  hasEdit: false,
  streaming: false,
  available: true,
};

describe('cardMenuOf', () => {
  it('offers nothing at all where the bridge is not loaded', () => {
    // Empty rather than disabled: an empty list is what makes the transcript menu fall through to
    // VS Code's own menu instead of showing a group nobody can use.
    expect(cardMenuOf({ ...ok, available: false, hasEdit: true })).toEqual([]);
    expect(contextOpBlocker({ ...ok, available: false })).toContain('pi 1.4');
  });

  it('offers omit and replace, and restore only for a card the model no longer reads', () => {
    expect(cardMenuOf(ok).map((item) => item.op)).toEqual(['omit', 'replace']);
    expect(cardMenuOf({ ...ok, hasEdit: true }).map((item) => item.op)).toEqual(
      ['omit', 'replace', 'restore'],
    );
  });

  it('disables every item while a run is going or an op is in flight', () => {
    // pi refuses both mid-run (`navigateTree` throws, and a `context_edit` has no boundary to land in),
    // so the menu refuses first rather than showing a click that cannot work.
    for (const input of [
      { ...ok, streaming: true },
      { ...ok, inFlight: 'omit' as const },
      { ...ok, hasEdit: true, inFlight: 'restore' as const },
    ]) {
      const items = cardMenuOf(input);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.disabled)).toBe(true);
    }
  });

  it('names the same three actions the card menu and the transcript menu both show', () => {
    expect(Object.keys(CONTEXT_OP_LABELS)).toEqual([
      'omit',
      'replace',
      'restore',
    ]);
    expect(cardMenuOf({ ...ok, hasEdit: true }).map((i) => i.label)).toEqual(
      Object.values(CONTEXT_OP_LABELS),
    );
  });

  it('says why nothing can be asked, and stays silent when something can', () => {
    expect(contextOpBlocker(ok)).toBeUndefined();
    expect(contextOpBlocker({ ...ok, streaming: true })).toContain('idle');
    expect(contextOpBlocker({ ...ok, inFlight: 'replace' })).toContain(
      'replace',
    );
  });
});
