import { describe, expect, it } from 'vitest';
import {
  STOP_NOTE_LIMIT_CHARS,
  clampStopNote,
  isShellTool,
  shellCommandOf,
  stopNoteText,
} from './stop-command';

/**
 * The shared half of the Stop feature: which calls have a process to stop, and what the model is told when one
 * is stopped. The bridge injects the sentence and the reason dialog previews it, so both sides read this file —
 * which is the only reason they cannot drift apart.
 */
describe('isShellTool / shellCommandOf', () => {
  it('recognises only the tools that spawn a process', () => {
    expect(isShellTool('bash')).toBe(true);
    expect(isShellTool('powershell')).toBe(true);
    expect(isShellTool('read')).toBe(false);
    expect(isShellTool('subagent')).toBe(false);
    expect(isShellTool(undefined)).toBe(false);
  });

  it('reads the command only when there is one', () => {
    expect(shellCommandOf('bash', { command: 'sleep 1' })).toBe('sleep 1');
    expect(shellCommandOf('bash', { command: '   ' })).toBeUndefined();
    expect(shellCommandOf('bash', {})).toBeUndefined();
    expect(shellCommandOf('bash', undefined)).toBeUndefined();
    // A `read` has no command, whatever its arguments carry.
    expect(shellCommandOf('read', { command: 'sleep 1' })).toBeUndefined();
  });
});

describe('stopNoteText', () => {
  it('is pi-gate’s shape when there is a note', () => {
    expect(stopNoteText('the port is taken')).toBe(
      'Stopped by user with note: the port is taken',
    );
  });

  it('still states what happened when the human pressed Enter on an empty field', () => {
    // pi-gate's rule: an empty note means the choice itself stands, so the model must not read silence.
    expect(stopNoteText('')).toContain('Stopped by user:');
    expect(stopNoteText()).not.toContain('with note');
  });
});

describe('clampStopNote', () => {
  it('trims, and keeps a normal sentence whole', () => {
    expect(clampStopNote('  move on  ')).toBe('move on');
    expect(clampStopNote('x'.repeat(STOP_NOTE_LIMIT_CHARS))).toHaveLength(
      STOP_NOTE_LIMIT_CHARS,
    );
  });

  it('truncates a pasted report instead of refusing it', () => {
    const clamped = clampStopNote('x'.repeat(STOP_NOTE_LIMIT_CHARS + 500));
    expect(clamped.length).toBeLessThan(STOP_NOTE_LIMIT_CHARS + 10);
    expect(clamped.endsWith('[…]')).toBe(true);
  });

  it('marks the cut, so a preview of a clamped note is honest about it', () => {
    const long = 'y'.repeat(STOP_NOTE_LIMIT_CHARS + 500);
    // The dialog previews `stopNoteText(clampStopNote(note))`; an unmarked cut would promise text that never
    // reaches the model.
    expect(stopNoteText(clampStopNote(long))).toContain('[…]');
    expect(stopNoteText(clampStopNote('short'))).not.toContain('[…]');
  });
});
