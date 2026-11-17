import { describe, expect, it } from 'vitest';
import {
  CONTEXT_OP_LABELS,
  STOP_DIALOG,
  STOP_LABELS,
  canStopCommand,
  canStopSubagent,
  cardMenuOf,
  contextOpBlocker,
  stopDialogOf,
  stopGateOf,
  stopNotePreview,
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
  // `subagentStop` is in every fixture because `StopInput` demands both capabilities: a card reads one object
  // and one gate, so a test cannot leave the run lever's flag out and get a free `undefined`.
  const live = { live: true, toolStop: true, subagentStop: false };

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
      canStopCommand({ ...live, toolStop: false, toolName: 'bash' }),
    ).toBe(false);
  });

  it('is not offered for a call the runtime is not executing', () => {
    // A card from a reloaded history has no live process, and stopping "the newest thing pi ran" would
    // abort whatever the agent is busy with instead.
    expect(
      canStopCommand({ ...live, live: false, toolName: 'bash' }),
    ).toBe(false);
  });

  it('keeps the two senses of “stop” in one vocabulary', () => {
    // The buttons are one row apart on the same card, so the wording is the only thing separating them.
    expect(STOP_LABELS.command).toContain('command');
    expect(STOP_LABELS.turn).toContain('turn');
    expect(STOP_LABELS.command).not.toBe(STOP_LABELS.turn);
    expect(STOP_DIALOG.command.subtitle).toContain('Abort this turn');
    expect(STOP_DIALOG.run.subtitle).toContain('Abort this turn');
  });
});

/**
 * The gate the control actually reads.
 *
 * This is where the first cut of the feature broke: the click handler asked its own question of
 * `canPressCommandStop` and passed a literal for "is a stop in flight", so the handler refused every press and
 * the two Stop buttons did nothing at all while every pure rule around them kept passing. One gate, read by the
 * handler and the render alike, is what the tests below pin — including the case a literal cannot reproduce.
 */
describe('stopGateOf', () => {
  const shell = { toolName: 'bash', live: true, toolStop: true, subagentStop: true };

  it('offers a command stop and lets it fire while nothing is in flight', () => {
    expect(stopGateOf(shell, false)).toEqual({
      offered: true,
      pressable: true,
      kind: 'command',
    });
  });

  it('keeps the controls offered while a stop is in flight, but stops them firing', () => {
    // A button that vanishes on press reads as a broken card; a second press would signal a process that is
    // already dying and answer a call the human has already stopped.
    const gate = stopGateOf(shell, true);
    expect(gate.offered).toBe(true);
    expect(gate.pressable).toBe(false);
  });

  it('answers the same gate for the handler and the render', () => {
    // An ineligible card answers one way, twice: it cannot look idle to the render and refuse to the click.
    const stopped = { ...shell, live: false };
    expect(stopGateOf(stopped, false)).toEqual({
      offered: false,
      pressable: false,
      kind: 'command',
    });
  });

  it('switches the lever on a subagent card, and only on one', () => {
    const card = { ...shell, toolName: 'subagent', run: true };
    expect(stopGateOf(card, false)).toEqual({
      offered: true,
      pressable: true,
      kind: 'run',
    });
    // A nested row of the same subagent is a command, and keeps the process lever.
    expect(stopGateOf({ ...shell, run: false }, false).kind).toBe('command');
    // No stop API published means no button, not a button that answers "unsupported".
    expect(
      stopGateOf({ ...card, subagentStop: false }, false).offered,
    ).toBe(false);
    // A finished subagent has no run to end.
    expect(stopGateOf({ ...card, live: false }, false).offered).toBe(false);
  });

  it('says the note the bridge will inject, in each lever’s own sentence', () => {
    const note = 'the server is already on :3000';
    expect(stopNotePreview('command', note)).toBe(
      `Stopped by user with note: ${note}`,
    );
    expect(stopNotePreview('run', note)).toBe(`Stopped by user with note: ${note}`);
    // With no reason the two levers part, because the thing that ended is different.
    expect(stopNotePreview('command', '')).toContain('command was terminated');
    expect(stopNotePreview('run', '')).toContain('subagent was stopped');
    // The dialog of a kind is the kind the gate named — one source for both.
    expect(stopDialogOf('run').title).toBe(STOP_LABELS.run);
  });
});

describe('canStopSubagent', () => {
  const running = {
    toolName: 'subagent',
    live: true,
    toolStop: true,
    subagentStop: true,
    run: true,
  };

  it('never claims the command lever for a run', () => {
    // A subagent is an in-process session: there is no process of its own to signal, so the command stop
    // could only ever aim at a command the child happens to be running.
    expect(canStopCommand(running)).toBe(false);
    expect(canStopSubagent(running)).toBe(true);
  });
});
