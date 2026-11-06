import { describe, expect, it } from 'vitest';
import type { HistoryMessage, ToolResultMessage } from '../../shared/protocol';
import type { ContextEditRecord } from '../session/session-store';
import { restoreOmittedToolResults } from './history-repair';

/**
 * Repairing a history snapshot for what the model may no longer re-read.
 *
 * `get_messages` answers with pi's *model-context projection* — the list the child is about to send,
 * which is the wrong list to paint: an omitted tool result is simply **absent** from it, so the card
 * would vanish from a transcript the user never deleted. The host puts the row back from the durable
 * `context_edit`, and what matters is *where*: a tool result belongs between its own reply and the
 * next one, in the order that reply asked for its calls, because the reducer keys cards by
 * `toolCallId` and pairs them with the call block it finds above.
 */

/** `get_messages` interleaves `role:'toolResult'` rows with the chat roles; the union does not model them. */
const snapshot = (rows: unknown[]): HistoryMessage[] =>
  rows as unknown as HistoryMessage[];

const call = (id: string, name = 'read') => ({
  type: 'toolCall',
  id,
  name,
  arguments: { path: 'src/a.ts' },
});

const reply = (calls: ReturnType<typeof call>[], text = 'looking') => ({
  role: 'assistant',
  content: [{ type: 'text', text }, ...calls],
});

const result = (
  toolCallId: string,
  text = `OUTPUT ${toolCallId}`,
  toolName = 'read',
) => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
});

const omission = (
  toolCallId: string,
  originalText = `ORIGINAL ${toolCallId}`,
): ContextEditRecord => ({
  targetId: `entry_${toolCallId}`,
  kind: 'omitted',
  originalText,
  originalToolCallId: toolCallId,
  originalRole: 'toolResult',
  timestamp: '2026-11-06T09:00:00.000Z',
  preCompaction: false,
});

const replacement = (
  toolCallId: string,
  newText: string,
): ContextEditRecord => ({
  targetId: `entry_${toolCallId}`,
  kind: 'replaced',
  replacementText: newText,
  originalText: `ORIGINAL ${toolCallId}`,
  originalToolCallId: toolCallId,
  originalRole: 'toolResult',
  timestamp: '2026-11-06T09:00:00.000Z',
  preCompaction: false,
});

/** The transcript as the reducer walks it: a row tag per line, the call id where there is one. */
const tags = (messages: HistoryMessage[]) =>
  messages.map(
    (message) =>
      (message as unknown as ToolResultMessage).toolCallId ?? message.role,
  );

const rowFor = (messages: HistoryMessage[], toolCallId: string) =>
  messages.find(
    (message) =>
      (message as unknown as ToolResultMessage).toolCallId === toolCallId,
  );

describe('restoreOmittedToolResults', () => {
  it('puts an omitted result back behind the sibling that survived', () => {
    // Two calls, one result in the projection: the repair must not staple the missing one to the
    // end of the run, and the `toolName` it paints comes from the call block (nothing else has it).
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2', 'bash')]),
      result('call_1'),
    ]);

    const next = restoreOmittedToolResults(history, [omission('call_2')]);
    expect(tags(next)).toEqual(['user', 'assistant', 'call_1', 'call_2']);
    expect(rowFor(next, 'call_2')).toEqual({
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ORIGINAL call_2' }],
    });
    // Copy-on-change: the caller's snapshot is what the identity comparison in the reducer rests on.
    expect(history).toHaveLength(3);
  });

  it('re-inserts the earlier of two results before the one that survived', () => {
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      result('call_2'),
    ]);

    expect(
      tags(restoreOmittedToolResults(history, [omission('call_1')])),
    ).toEqual(['user', 'assistant', 'call_1', 'call_2']);
  });

  it('re-inserts both results of a reply the projection emptied', () => {
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      reply([], 'done'),
    ]);

    const next = restoreOmittedToolResults(history, [
      omission('call_1'),
      omission('call_2'),
    ]);
    // Both land inside the emptied run, before the next reply — the transcript never sees a card
    // floating after the answer that follows the tool calls.
    expect(tags(next)).toEqual([
      'user',
      'assistant',
      expect.any(String),
      expect.any(String),
      'assistant',
    ]);
    expect(new Set(next.slice(2, 4).map((row) => tags([row])[0]))).toEqual(
      new Set(['call_1', 'call_2']),
    );
    expect(
      next
        .slice(2, 4)
        .every((row) => (row as { role?: string }).role === 'toolResult'),
    ).toBe(true);
  });

  it('re-inserts a whole omitted run in call order', () => {
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      reply([], 'done'),
    ]);

    expect(
      tags(
        restoreOmittedToolResults(history, [
          omission('call_1'),
          omission('call_2'),
        ]),
      ),
    ).toEqual(['user', 'assistant', 'call_1', 'call_2', 'assistant']);
  });

  it('returns the very array it was given when there is nothing to repair', () => {
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1')]),
      result('call_1'),
    ]);
    expect(restoreOmittedToolResults(history, [])).toBe(history);

    // An id this snapshot never saw: an edit of another branch, or a card the user rewound away.
    expect(restoreOmittedToolResults(history, [omission('call_9')])).toBe(
      history,
    );
  });

  it('does not staple a result whose owning reply left the snapshot', () => {
    // A summarised-away call: without its assistant block there is no run to insert into, and a row
    // at the head of the transcript would be a card the reducer cannot attribute to anybody.
    const history = snapshot([{ role: 'user', content: 'long ago' }]);
    expect(restoreOmittedToolResults(history, [omission('call_1')])).toBe(
      history,
    );

    // The same for a badge that names no tool call at all — an omitted user ask or assistant reply.
    const replyEdit: ContextEditRecord = {
      targetId: 'entry_u1',
      kind: 'omitted',
      originalText: 'a deleted ask',
      originalRole: 'user',
      timestamp: '2026-11-06T09:00:00.000Z',
      preCompaction: false,
    };
    expect(restoreOmittedToolResults(history, [replyEdit])).toBe(history);
  });

  it('never touches the rows of a replacement', () => {
    // The projection already shows the new text, which is what a replaced card paints: rewriting the
    // row here would undo the badge's whole point.
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      result('call_1', 'EDITED TEXT'),
      result('call_2', 'EDITED TEXT'),
    ]);
    expect(
      restoreOmittedToolResults(history, [
        replacement('call_1', 'EDITED TEXT'),
        replacement('call_2', 'EDITED TEXT'),
      ]),
    ).toBe(history);

    // Mixed with a real omission, still only the omitted row is added — and the replaced one is left
    // alone, projection text and all.
    const oneGone = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      result('call_1', 'EDITED TEXT'),
    ]);
    const next = restoreOmittedToolResults(oneGone, [
      replacement('call_1', 'EDITED TEXT'),
      omission('call_2'),
    ]);
    expect(next).not.toBe(oneGone);
    expect(tags(next)).toEqual(['user', 'assistant', 'call_1', 'call_2']);
  });

  it('does not duplicate a result the projection still carries', () => {
    // Not-yet-applied projection (the edit is durable, but pi has not sent a request since), and the
    // mirror case after a revert: either way the row is there, and a second card for one call is the
    // duplicate the reducer cannot key away.
    const history = snapshot([
      { role: 'user', content: 'read both' },
      reply([call('call_1'), call('call_2')]),
      result('call_1'),
      result('call_2'),
    ]);
    expect(restoreOmittedToolResults(history, [omission('call_1')])).toBe(
      history,
    );

    const next = restoreOmittedToolResults(history, [
      omission('call_1'),
      omission('call_9'),
    ]);
    expect(next).toBe(history);
    expect(
      tags(next).filter((tag) => tag === 'call_1' || tag === 'call_2'),
    ).toEqual(['call_1', 'call_2']);
  });

  it('keeps each omission inside its own reply', () => {
    // Two turns, one omission each: sorted insertion has to respect the runs, not just the positions —
    // an id of the second turn must not end up below the first reply.
    const history = snapshot([
      { role: 'user', content: 'first' },
      reply([call('call_1'), call('call_2')]),
      result('call_1'),
      reply([call('call_3'), call('call_4')]),
      result('call_3'),
    ]);

    const next = restoreOmittedToolResults(history, [
      omission('call_2'),
      omission('call_4'),
    ]);
    expect(tags(next)).toEqual([
      'user',
      'assistant',
      'call_1',
      'call_2',
      'assistant',
      'call_3',
      'call_4',
    ]);
  });
});
