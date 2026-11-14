import { describe, expect, it } from 'vitest';
import {
  CONTEXT_OP_LABELS,
  STOP_DIALOG,
  STOP_LABELS,
  canPressCommandStop,
  canStopCommand,
  cardMenuOf,
  contextOpBlocker,
} from './card-menu';

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

/**
 * The other Stop. `cardMenuOf` decides what may be asked of a conversation pi is not writing; these rules
 * decide what may be asked of a command pi is running right now — which is why they are the opposite shape:
 * gated on liveness and on the bridge's `toolStop`, never on `streaming`.
 */
describe('canStopCommand', () => {
  const live = { live: true, toolStop: true };

  it('offers it for a running shell call and for nothing else', () => {
    expect(canStopCommand({ ...live, toolName: 'bash' })).toBe(true);
    expect(canStopCommand({ ...live, toolName: 'powershell' })).toBe(true);
    // No process to signal: a hung `grep` is a hung regexp.
    expect(canStopCommand({ ...live, toolName: 'read' })).toBe(false);
    expect(canStopCommand({ ...live, toolName: 'subagent' })).toBe(false);
  });

  it('is hidden when the runtime cannot honour it', () => {
    // A bridge built before the feature, an old pi, a missing bundle: all the same answer, and all of
    // them leave the abort control standing, which is what the card offered before this existed.
    expect(
      canStopCommand({ live: true, toolStop: false, toolName: 'bash' }),
    ).toBe(false);
  });

  it('is not offered for a call the runtime is not executing', () => {
    // A card from a reloaded history has no live process, and stopping "the newest thing pi ran" would
    // abort whatever the agent is busy with instead.
    expect(
      canStopCommand({ live: false, toolStop: true, toolName: 'bash' }),
    ).toBe(false);
  });

  it('keeps the controls offered while a stop is in flight, but stops them firing', () => {
    // A button that vanishes on press reads as a broken card; a second press would signal a process that is
    // already dying and answer a call the human has already stopped.
    const inflight = { live: true, toolStop: true, toolName: 'bash' };
    expect(canStopCommand(inflight)).toBe(true);
    expect(canPressCommandStop({ ...inflight, pending: true })).toBe(false);
    expect(canPressCommandStop({ ...inflight, pending: false })).toBe(true);
  });

  it('keeps the two senses of “stop” in one vocabulary', () => {
    // The buttons are one row apart on the same card, so the wording is the only thing separating them.
    expect(STOP_LABELS.command).toContain('command');
    expect(STOP_LABELS.turn).toContain('turn');
    expect(STOP_LABELS.command).not.toBe(STOP_LABELS.turn);
    expect(STOP_DIALOG.subtitle).toContain('Abort this turn');
  });
});
