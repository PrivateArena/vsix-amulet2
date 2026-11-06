import { describe, expect, it } from 'vitest';
import {
  entryIdOfToolCallId,
  expandOmitGroup,
  isPreCompaction,
  resolveTargets,
  type ResolveResult,
} from './target-resolver';
import type {
  ReadonlySessionManager,
  SessionEntry,
  SessionMessageEntry,
} from './pi-extension-api';

/**
 * Addressing, which is the part of the bridge that decides what actually leaves context: the host names
 * a `toolCallId` (all a live card has — `get_messages` answers with projection messages that carry no id)
 * and the bridge turns that into session entries on the active branch.
 *
 * The fixture is a hand-built pi branch — user message, an assistant reply asking for two tool calls,
 * one result per call, then a second user message — because the group rule ("a tool call may not survive
 * its result") can only be seen when siblings and a parent are present.
 */

const T = '2026-11-06T09:00:00.000Z';

function userEntry(
  id: string,
  parentId: string | null,
  text: string,
): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: T,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantEntry(
  id: string,
  parentId: string | null,
  calls: Array<{ id: string; name: string }>,
  text = 'let me look',
): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: T,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...calls.map((call) => ({
          type: 'toolCall',
          id: call.id,
          name: call.name,
          arguments: {},
        })),
      ],
    },
  };
}

function toolResultEntry(
  id: string,
  parentId: string | null,
  toolCallId: string,
  text: string,
): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: T,
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: toolCallId.replace(/^call_/, ''),
      content: [{ type: 'text', text }],
    },
  };
}

/** `u1 → a1(call_read, call_bash) → tr_read → tr_bash → u2`, the way pi persists one tool turn. */
function branchFixture(): SessionMessageEntry[] {
  return [
    userEntry('u1', null, 'read the plan and run the tests'),
    assistantEntry('a1', 'u1', [
      { id: 'call_read', name: 'read' },
      { id: 'call_bash', name: 'bash' },
    ]),
    toolResultEntry('tr_read', 'a1', 'call_read', '…file contents…'),
    toolResultEntry('tr_bash', 'a1', 'call_bash', '3 passed'),
    userEntry('u2', 'tr_bash', 'now fix it'),
  ];
}

/**
 * The read-only view pi hands an extension, over a fixture array: the branch is the array itself, and
 * the compaction-aware projection is a slice of it (everything, unless a test says otherwise).
 */
function managerOf(
  entries: SessionEntry[],
  contextEntries: SessionEntry[] = entries,
): ReadonlySessionManager {
  return {
    getCwd: () => '/work',
    getSessionDir: () => '/work/.pi/agent/sessions/+work',
    getSessionId: () => 'session-1',
    getSessionFile: () => '/work/.pi/agent/sessions/+work/session-1.jsonl',
    getLeafId: () => entries.at(-1)?.id ?? null,
    getLeafEntry: () => entries.at(-1),
    getEntry: (id) => entries.find((entry) => entry.id === id),
    getBranch: () => [...entries],
    buildContextEntries: () => [...contextEntries],
  };
}

function ok(resolved: ResolveResult) {
  if (!resolved.ok)
    throw new Error(`resolve failed: ${resolved.code} — ${resolved.error}`);
  return resolved;
}

function failure(resolved: ResolveResult) {
  if (resolved.ok)
    throw new Error(`resolve unexpectedly succeeded: ${resolved.groupIds}`);
  return resolved;
}

describe('resolveTargets', () => {
  it('resolves a tool result to that result alone', () => {
    const entries = branchFixture();
    const resolved = ok(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_read' },
        managerOf(entries),
        'group',
      ),
    );

    // NOT the whole turn: an omitted result is answered by a placeholder, so the reply and its sibling
    // result stay in context — and in the transcript, which is the difference between hiding one output
    // and deleting a message nobody asked to delete.
    expect(resolved.groupIds).toEqual(['tr_read']);
    expect(resolved.targets).toEqual([
      { entryId: 'tr_read', role: 'toolResult', toolCallId: 'call_read' },
    ]);
  });

  it('resolves an addressed reply to the whole turn', () => {
    const entries = branchFixture();
    const resolved = ok(
      resolveTargets(
        { kind: 'entry', entryId: 'a1' },
        managerOf(entries),
        'group',
      ),
    );
    // Deleting a reply without its results would orphan every call it made, so they go together.
    expect(resolved.groupIds).toEqual(['a1', 'tr_read', 'tr_bash']);
    expect(resolved.targets).toEqual([
      { entryId: 'a1', role: 'assistant' },
      { entryId: 'tr_read', role: 'toolResult', toolCallId: 'call_read' },
      { entryId: 'tr_bash', role: 'toolResult', toolCallId: 'call_bash' },
    ]);
  });

  it('resolves either result of a reply to its own result only', () => {
    const entries = branchFixture();
    const sm = managerOf(entries);
    const fromRead = ok(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_read' },
        sm,
        'group',
      ),
    );
    const fromBash = ok(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_bash' },
        sm,
        'group',
      ),
    );
    expect(fromRead.groupIds).toEqual(['tr_read']);
    expect(fromBash.groupIds).toEqual(['tr_bash']);
  });

  it('returns only the addressed result in single scope', () => {
    const entries = branchFixture();
    const resolved = ok(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_read' },
        managerOf(entries),
        'single',
      ),
    );

    expect(resolved.groupIds).toEqual(['tr_read']);
    expect(resolved.targets).toEqual([
      { entryId: 'tr_read', role: 'toolResult', toolCallId: 'call_read' },
    ]);
  });

  it('resolves a plain user message to that entry alone', () => {
    const entries = branchFixture();
    const resolved = ok(
      resolveTargets(
        { kind: 'entry', entryId: 'u1' },
        managerOf(entries),
        'group',
      ),
    );

    // No group to expand: a user message has no results that could be orphaned.
    expect(resolved.groupIds).toEqual(['u1']);
    expect(resolved.targets).toEqual([{ entryId: 'u1', role: 'user' }]);
  });

  it('reports an entry that is not on the branch', () => {
    const failed = failure(
      resolveTargets(
        { kind: 'entry', entryId: 'gone' },
        managerOf(branchFixture()),
        'group',
      ),
    );
    expect(failed.code).toBe('no-such-entry');
  });

  it('reports a tool call id this branch never ran', () => {
    const failed = failure(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_nope' },
        managerOf(branchFixture()),
        'group',
      ),
    );
    expect(failed.code).toBe('unknown-handle');
  });

  it('takes the newest of two identical user texts when told to', () => {
    const entries = [
      ...branchFixture(),
      assistantEntry(
        'a2',
        'u2',
        [{ id: 'call_edit', name: 'edit' }],
        'editing',
      ),
      userEntry('u3', 'a2', 'now fix it'),
    ];
    const handle = {
      kind: 'userText',
      text: 'now fix it',
      occurrence: 'newest',
    } as const;

    const resolved = ok(resolveTargets(handle, managerOf(entries), 'single'));
    expect(resolved.groupIds).toEqual(['u3']);
    expect(resolved.targets).toEqual([{ entryId: 'u3', role: 'user' }]);
  });

  it('refuses to guess between two identical user texts', () => {
    const entries = [
      ...branchFixture(),
      assistantEntry(
        'a2',
        'u2',
        [{ id: 'call_edit', name: 'edit' }],
        'editing',
      ),
      userEntry('u3', 'a2', 'now fix it'),
    ];
    const failed = failure(
      resolveTargets(
        { kind: 'userText', text: 'now fix it' },
        managerOf(entries),
        'single',
      ),
    );
    expect(failed.code).toBe('ambiguous-handle');
  });

  it('fails with pre-compaction when the entry is already summarised away', () => {
    const entries = branchFixture();
    // The newest compaction kept only the last user message.
    const sm = managerOf(entries, entries.slice(4));

    const failed = failure(
      resolveTargets(
        { kind: 'toolCall', toolCallId: 'call_read' },
        sm,
        'group',
      ),
    );
    expect(failed.code).toBe('pre-compaction');

    // …while an entry the projection still carries resolves normally.
    expect(
      ok(resolveTargets({ kind: 'entry', entryId: 'u2' }, sm, 'group'))
        .groupIds,
    ).toEqual(['u2']);
  });
});

describe('expandOmitGroup', () => {
  it('takes every result with an addressed reply', () => {
    const entries = branchFixture();
    const assistant = entries[1];

    // Addressing the reply directly is the case that must take the results: with the reply gone, the
    // calls it made have nothing to answer them.
    expect(expandOmitGroup(assistant, entries)).toEqual([
      'a1',
      'tr_read',
      'tr_bash',
    ]);
    // A single result stands alone; its placeholder keeps the turn valid.
    expect(expandOmitGroup(entries[2], entries)).toEqual(['tr_read']);
  });

  it('stops the group at the next assistant turn', () => {
    const entries = [
      ...branchFixture(),
      assistantEntry(
        'a2',
        'u2',
        [{ id: 'call_edit', name: 'edit' }],
        'editing',
      ),
      toolResultEntry('tr_edit', 'a2', 'call_edit', 'ok'),
    ];

    expect(expandOmitGroup(entries[1], entries)).toEqual([
      'a1',
      'tr_read',
      'tr_bash',
    ]);
    // The later turn is its own group: the first reply's group never reaches past it.
    expect(expandOmitGroup(entries[5], entries)).toEqual(['a2', 'tr_edit']);
    expect(expandOmitGroup(entries[6], entries)).toEqual(['tr_edit']);
  });

  it('leaves a message with no tool calls alone', () => {
    const entries = branchFixture();
    expect(expandOmitGroup(entries[4], entries)).toEqual(['u2']);
  });
});

describe('entryIdOfToolCallId', () => {
  it('finds the result entry of a call on the branch', () => {
    const sm = managerOf(branchFixture());
    expect(entryIdOfToolCallId('call_read', sm)).toBe('tr_read');
    expect(entryIdOfToolCallId('call_bash', sm)).toBe('tr_bash');
  });

  it('returns undefined for a call this branch never answered', () => {
    const sm = managerOf(branchFixture());
    expect(entryIdOfToolCallId('call_unknown', sm)).toBeUndefined();
  });

  it('prefers the newest result when a call id was replayed', () => {
    const entries: SessionEntry[] = [
      ...branchFixture(),
      assistantEntry(
        'a2',
        'u2',
        [{ id: 'call_read', name: 'read' }],
        'reading it again',
      ),
      toolResultEntry('tr_read_2', 'a2', 'call_read', '…newer contents…'),
    ];

    expect(entryIdOfToolCallId('call_read', managerOf(entries))).toBe(
      'tr_read_2',
    );
  });

  it('ignores the assistant entry that asked for the call', () => {
    const sm = managerOf(branchFixture());
    expect(entryIdOfToolCallId('call_read', sm)).not.toBe('a1');
  });
});

describe('isPreCompaction', () => {
  it('is false while the projection still carries the entry', () => {
    const entries = branchFixture();
    const sm = managerOf(entries);
    for (const entry of entries) {
      expect(isPreCompaction(entry.id, sm)).toBe(false);
    }
  });

  it('is true for an entry the newest compaction summarised past', () => {
    const entries = branchFixture();
    const kept = entries.slice(3);
    const sm = managerOf(entries, kept);

    expect(isPreCompaction('tr_bash', sm)).toBe(false);
    expect(isPreCompaction('u2', sm)).toBe(false);
    expect(isPreCompaction('u1', sm)).toBe(true);
    expect(isPreCompaction('a1', sm)).toBe(true);
    expect(isPreCompaction('never-existed', sm)).toBe(true);
  });
});
