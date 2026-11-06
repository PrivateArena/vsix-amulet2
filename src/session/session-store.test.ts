import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  listSessions,
  readBranchCompactions,
  readBranchContextEdits,
  sessionsDirForCwd,
  type ContextEditRecord,
} from './session-store';

/**
 * The compaction boundaries are read out of pi's session file, because `get_messages` answers
 * with the pruned model-context projection. What matters here is that the file is parsed the way
 * pi wrote it: an append log whose entries are not all on the branch being resumed.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amulet-session-store-'));

const line = (entry: unknown) => JSON.stringify(entry);

const messageEntry = (id: string, parentId: string | null) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-11-02T16:37:40.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `turn ${id}` }],
      timestamp: 1_700_000_000_000,
    },
  });

const compactionEntry = (
  id: string,
  parentId: string | null,
  tokensBefore: number,
) =>
  line({
    type: 'compaction',
    id,
    parentId,
    timestamp: '2026-11-02T16:37:44.052Z',
    summary: `summary ${id}`,
    firstKeptEntryId: parentId,
    tokensBefore,
    details: { readFiles: ['/repo/a.ts'], modifiedFiles: [] },
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
    },
  });

function writeSession(name: string, lines: string[]): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readBranchCompactions', () => {
  it('reads every boundary of the branch, oldest first, with its detail', () => {
    const filePath = writeSession('linear.jsonl', [
      line({
        type: 'session',
        version: 3,
        id: 's1',
        timestamp: '2026-11-02T14:48:20.126Z',
        cwd: '/repo',
      }),
      messageEntry('m1', null),
      compactionEntry('c1', 'm1', 227_433),
      messageEntry('m2', 'c1'),
      compactionEntry('c2', 'm2', 186_491),
      messageEntry('m3', 'c2'),
    ]);

    const boundaries = readBranchCompactions(filePath);
    expect(boundaries.map((b) => b.tokensBefore)).toEqual([227_433, 186_491]);
    expect(boundaries[1]).toMatchObject({
      summary: 'summary c2',
      details: { readFiles: ['/repo/a.ts'], modifiedFiles: [] },
      usage: { totalTokens: 11 },
    });
  });

  it('ignores boundaries of a branch the session did not resume', () => {
    // `c1` is on the branch that was abandoned at the fork; the file ends on `x1`'s descendant.
    const abandoned = writeSession('forked.jsonl', [
      line({ type: 'session', version: 3, id: 's2', cwd: '/repo' }),
      messageEntry('m1', null),
      compactionEntry('c1', 'm1', 111_000),
      messageEntry('m2', 'c1'),
      compactionEntry('x1', 'm1', 222_000),
      messageEntry('m3', 'x1'),
    ]);
    expect(readBranchCompactions(abandoned).map((b) => b.id)).toEqual(['x1']);

    const resumed = writeSession('fork-target.jsonl', [
      line({ type: 'session', version: 3, id: 's3', cwd: '/repo' }),
      messageEntry('m1', null),
      compactionEntry('c1', 'm1', 111_000),
      messageEntry('m2', 'c1'),
      compactionEntry('c2', 'm2', 186_491),
    ]);
    expect(readBranchCompactions(resumed).map((b) => b.id)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('notices a boundary pi appended after the last read', () => {
    // The result is memoised per file identity, so a resumed session must not show yesterday's
    // boundaries: pi writes every appended entry, so the size — not the timestamp, which one of
    // these fixtures would outrun — is what says the file moved.
    const filePath = path.join(dir, 'grown.jsonl');
    const header = line({
      type: 'session',
      version: 3,
      id: 's6',
      cwd: '/repo',
    });
    fs.writeFileSync(
      filePath,
      `${[header, compactionEntry('c1', null, 100_000)].join('\n')}\n`,
    );
    expect(readBranchCompactions(filePath).map((b) => b.id)).toEqual(['c1']);

    fs.appendFileSync(
      filePath,
      `${[messageEntry('m2', 'c1'), compactionEntry('c2', 'm2', 190_000)].join('\n')}\n`,
    );
    expect(readBranchCompactions(filePath).map((b) => b.id)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('gives up what it cannot read, without losing the boundaries below it', () => {
    const plain = writeSession('plain.jsonl', [
      line({ type: 'session', version: 3, id: 's4', cwd: '/repo' }),
      messageEntry('m1', null),
    ]);
    expect(readBranchCompactions(plain)).toEqual([]);

    // A torn head: not even the id is on disk yet, so the line is not an entry at all.
    const tornHead = writeSession('torn-head.jsonl', [
      line({ type: 'session', version: 3, id: 's5', cwd: '/repo' }),
      compactionEntry('c1', null, 100_000),
      '{"type":"compact',
    ]);
    expect(readBranchCompactions(tornHead).map((b) => b.id)).toEqual(['c1']);

    // A truncated tail: the link parses, the entry does not, so the boundary is not durable.
    const tornTail = writeSession('torn-tail.jsonl', [
      line({ type: 'session', version: 3, id: 's7', cwd: '/repo' }),
      compactionEntry('c1', null, 100_000),
      '{"type":"compaction","id":"c2","parentId":"c1","sum',
    ]);
    expect(readBranchCompactions(tornTail).map((b) => b.id)).toEqual(['c1']);

    // An extension entry whose payload pushes `id`/`parentId` past the entry-head scan window is
    // not a node, so the walk stops short: nothing is invented, and the projection stays as it was.
    const beyondWindow = writeSession('fat-custom.jsonl', [
      line({ type: 'session', version: 3, id: 's8', cwd: '/repo' }),
      compactionEntry('c1', null, 100_000),
      line({
        type: 'custom',
        customType: 'x',
        data: { blob: 'y'.repeat(4096) },
        id: 'x1',
        parentId: 'c1',
      }),
      messageEntry('m2', 'x1'),
    ]);
    expect(readBranchCompactions(beyondWindow)).toEqual([]);

    expect(readBranchCompactions(path.join(dir, 'missing.jsonl'))).toEqual([]);
    expect(readBranchCompactions(undefined)).toEqual([]);
    expect(readBranchCompactions(dir)).toEqual([]);
  });
});

/**
 * The durable `context_edit` lines of the branch a session file currently ends on.
 *
 * An edit is invisible everywhere else: `get_messages` answers with the projection the edit already
 * changed, so an omitted tool result is simply gone from the history. Only the file still holds both
 * halves — the edit and the output it aimed at, which the edit never rewrites. That makes three things
 * worth pinning down: the branch walk (an edit left behind by a fork must not badge the live
 * transcript), the pairing with the persisted target, and the fact that a half-written line is not an
 * edit yet. All of it has to stay cheap, so the reader walks regexes over the file rather than
 * `JSON.parse`ing megabytes — which is exactly where a silently-skipped line could come from.
 */
const editsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amulet-edits-'));

/** One distinct ISO stamp per fixture line; pi stamps every entry it appends. */
const t = (second: number) =>
  `2026-11-06T09:00:${String(second).padStart(2, '0')}.000Z`;

const sessionLine = (id: string, cwd = '/repo') =>
  line({
    type: 'session',
    version: 3,
    id,
    timestamp: t(0),
    cwd,
  });

const userLine = (id: string, parentId: string | null, text: string, at = 1) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: t(at),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.parse(t(at)),
    },
  });

const assistantLine = (
  id: string,
  parentId: string | null,
  callIds: string[],
  text = 'looking',
  at = 2,
) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: t(at),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...callIds.map((callId) => ({
          type: 'toolCall',
          id: callId,
          name: 'read',
          arguments: {},
        })),
      ],
      timestamp: Date.parse(t(at)),
    },
  });

const toolResultLine = (
  id: string,
  parentId: string | null,
  toolCallId: string,
  text: string,
  at = 3,
) =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: t(at),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: Date.parse(t(at)),
    },
  });

const contextEditLine = (
  id: string,
  parentId: string | null,
  targetId: string,
  replacement: { content: unknown } | null,
  at = 4,
) =>
  line({
    type: 'context_edit',
    id,
    parentId,
    timestamp: t(at),
    targetId,
    replacement,
  });

const compactionLine = (
  id: string,
  parentId: string | null,
  firstKeptEntryId: string,
  at = 4,
) =>
  line({
    type: 'compaction',
    id,
    parentId,
    timestamp: t(at),
    summary: `summary ${id}`,
    firstKeptEntryId,
    tokensBefore: 1000,
    details: { readFiles: ['/repo/a.ts'], modifiedFiles: [] },
  });

/** One user ask, the assistant call block and the tool output that answers it. */
const roundTrip = (parentId: string | null, at = 1) => [
  userLine('u1', parentId, 'read the file', at),
  assistantLine('a1', 'u1', ['call_1'], 'looking', at + 1),
  toolResultLine('tr1', 'a1', 'call_1', 'ORIGINAL OUTPUT', at + 2),
];

function writeEdits(name: string, lines: string[]): string {
  const filePath = path.join(editsDir, name);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

/** The single record every case below expects, with the "nothing else leaked in" check built in. */
function onlyEdit(edits: ContextEditRecord[]): ContextEditRecord {
  expect(edits).toHaveLength(1);
  return edits[0];
}

afterAll(() => {
  fs.rmSync(editsDir, { recursive: true, force: true });
});

describe('readBranchContextEdits', () => {
  it('reports an omission with the output the model can no longer re-read', async () => {
    const filePath = writeEdits('omit.jsonl', [
      sessionLine('s1'),
      ...roundTrip(null),
      contextEditLine('e1', 'tr1', 'tr1', null),
    ]);

    expect(await readBranchContextEdits(filePath)).toEqual([
      {
        targetId: 'tr1',
        kind: 'omitted',
        replacementText: undefined,
        originalText: 'ORIGINAL OUTPUT',
        originalToolCallId: 'call_1',
        originalRole: 'toolResult',
        timestamp: t(4),
        preCompaction: false,
      },
    ]);
  });

  it('reports a replacement beside the untouched persisted text', async () => {
    // An edit is a projection note, not a rewrite: the file keeps the real output, and the card has
    // to keep showing it. `replacementText` joins the blocks the way the reader reads them (`\n`).
    const filePath = writeEdits('replace.jsonl', [
      sessionLine('s2'),
      ...roundTrip(null),
      contextEditLine('e1', 'tr1', 'tr1', {
        content: [
          { type: 'text', text: 'FIRST CHUNK' },
          { type: 'text', text: 'SECOND' },
        ],
      }),
    ]);

    expect(onlyEdit(await readBranchContextEdits(filePath))).toMatchObject({
      kind: 'replaced',
      replacementText: 'FIRST CHUNK\nSECOND',
      originalText: 'ORIGINAL OUTPUT',
      originalToolCallId: 'call_1',
    });
  });

  it('lets the newest edit of one target decide the kind', async () => {
    const omittedThenReplaced = writeEdits('replace-then-omit.jsonl', [
      sessionLine('s3'),
      ...roundTrip(null),
      contextEditLine(
        'e1',
        'tr1',
        'tr1',
        { content: [{ type: 'text', text: 'NEW' }] },
        4,
      ),
      contextEditLine('e2', 'e1', 'tr1', null, 5),
    ]);
    expect(onlyEdit(await readBranchContextEdits(omittedThenReplaced))).toEqual(
      {
        targetId: 'tr1',
        kind: 'omitted',
        replacementText: undefined,
        originalText: 'ORIGINAL OUTPUT',
        originalToolCallId: 'call_1',
        originalRole: 'toolResult',
        timestamp: t(5),
        preCompaction: false,
      },
    );

    // The reverse order is a live replacement, so a badge that only looked at the first edit line
    // would say "omitted" over a card the model can still read (differently).
    const replacedAfterOmit = writeEdits('omit-then-replace.jsonl', [
      sessionLine('s4'),
      ...roundTrip(null),
      contextEditLine('e1', 'tr1', 'tr1', null, 4),
      contextEditLine(
        'e2',
        'e1',
        'tr1',
        { content: [{ type: 'text', text: 'NEW' }] },
        5,
      ),
    ]);
    expect(
      onlyEdit(await readBranchContextEdits(replacedAfterOmit)),
    ).toMatchObject({
      kind: 'replaced',
      replacementText: 'NEW',
      timestamp: t(5),
    });
  });

  it('follows the newest branch, so an edit of a forked-away run is not returned', async () => {
    // The user rewound to `a1` and continued: `u2` is the newest line of the live branch even
    // though `tr1`/`e_old` were written first, so the omission made there says nothing about the
    // transcript the user is reading — and it would be read from the file if the scan were flat.
    const filePath = writeEdits('forked.jsonl', [
      sessionLine('s5'),
      ...roundTrip(null),
      contextEditLine('e_old', 'tr1', 'tr1', null, 4),
      userLine('u2', 'a1', 'actually, read it again', 5),
      assistantLine('a2', 'u2', ['call_2'], 'looking again', 6),
      toolResultLine('tr2', 'a2', 'call_2', 'OUTPUT OF THE LIVE BRANCH', 7),
      contextEditLine('e_new', 'tr2', 'tr2', null, 8),
    ]);

    const edits = await readBranchContextEdits(filePath);
    expect(edits.map((edit) => edit.targetId)).toEqual(['tr2']);
    expect(onlyEdit(edits)).toMatchObject({
      originalText: 'OUTPUT OF THE LIVE BRANCH',
      originalToolCallId: 'call_2',
    });
  });

  it('marks a target the newest compaction summarised away', async () => {
    // `c1` kept everything from `a2` on, so the output before it is out of the model's context for
    // good: the badge has to offer Compact instead of an edit that changes nothing the model reads.
    // `a2` itself is the first kept entry, so editing it still reaches the model.
    const filePath = writeEdits('compacted.jsonl', [
      sessionLine('s6'),
      ...roundTrip(null),
      compactionLine('c1', 'tr1', 'a2', 4),
      userLine('u2', 'c1', 'and once more', 5),
      assistantLine('a2', 'u2', ['call_2'], 'looking again', 6),
      toolResultLine('tr2', 'a2', 'call_2', 'OUTPUT AFTER THE BOUNDARY', 7),
      contextEditLine('e1', 'tr2', 'tr1', null, 8),
      contextEditLine(
        'e2',
        'e1',
        'a2',
        { content: [{ type: 'text', text: 'TERSE' }] },
        9,
      ),
    ]);

    const edits = await readBranchContextEdits(filePath);
    expect(edits.map((edit) => [edit.targetId, edit.preCompaction])).toEqual([
      ['tr1', true],
      ['a2', false],
    ]);
    // The cutoff id itself counts as kept, and the record of a reply carries no call id.
    expect(edits[1]).toMatchObject({
      kind: 'replaced',
      originalRole: 'assistant',
      originalToolCallId: undefined,
      originalText: 'looking again',
    });
  });

  it('is silent about a restore, which is an edit that changed nothing', async () => {
    // pi's edit log is append-only, so undoing an omission appends the original content back. The
    // newest edit is then a no-op, and a badge over the real output would be a lie.
    const restored = writeEdits('restore.jsonl', [
      sessionLine('s7'),
      ...roundTrip(null),
      contextEditLine(
        'e1',
        'tr1',
        'tr1',
        { content: [{ type: 'text', text: 'NEW' }] },
        4,
      ),
      contextEditLine(
        'e2',
        'e1',
        'tr1',
        {
          content: [{ type: 'text', text: 'ORIGINAL OUTPUT' }],
        },
        5,
      ),
    ]);
    expect(await readBranchContextEdits(restored)).toEqual([]);

    // Only an exact copy of the persisted text is a restore.
    const partly = writeEdits('partly-restored.jsonl', [
      sessionLine('s8'),
      ...roundTrip(null),
      contextEditLine(
        'e1',
        'tr1',
        'tr1',
        { content: [{ type: 'text', text: 'NEW' }] },
        4,
      ),
      contextEditLine(
        'e2',
        'e1',
        'tr1',
        {
          content: [{ type: 'text', text: 'ORIGINAL OUTPUT (trimmed)' }],
        },
        5,
      ),
    ]);
    expect(onlyEdit(await readBranchContextEdits(partly))).toMatchObject({
      kind: 'replaced',
      replacementText: 'ORIGINAL OUTPUT (trimmed)',
    });
  });

  it('skips what it cannot badge and what is not durable yet', async () => {
    // `x1` is an extension's injected message and `sy1` a system line: neither is a card, and the
    // transcript has nowhere to put a badge for either. `e_torn` is half a line — pi appends, so a
    // trailing fragment is an entry that does not exist until the next write completes it.
    const filePath = writeEdits('skipped.jsonl', [
      sessionLine('s9'),
      ...roundTrip(null),
      line({
        type: 'custom_message',
        id: 'x1',
        parentId: 'tr1',
        timestamp: t(4),
        customType: 'amulet:note',
        content: [{ type: 'text', text: 'INJECTED NOTE' }],
        display: true,
      }),
      line({
        type: 'message',
        id: 'sy1',
        parentId: 'x1',
        timestamp: t(5),
        message: { role: 'system', content: 'SYSTEM LINE' },
      }),
      contextEditLine(
        'e1',
        'sy1',
        'x1',
        { content: [{ type: 'text', text: 'OMITTED' }] },
        6,
      ),
      contextEditLine('e2', 'e1', 'sy1', null, 7),
      contextEditLine('e3', 'e2', 'tr1', null, 8),
      line({
        type: 'context_edit',
        id: 'e4',
        parentId: 'e3',
        timestamp: t(9),
        replacement: null,
      }),
      '{"type":"context_edit","id":"e5","parentId":"e4","timestamp":"2026-11-06T09:00:10.000Z"' +
        ',"targetId":"a1","replacement":{"content":[{"type":"text","text":"TOR',
    ]);

    const edits = await readBranchContextEdits(filePath);
    expect(edits.map((edit) => edit.targetId)).toEqual(['tr1']);
  });

  it('gives up on a file it cannot read, without throwing', async () => {
    expect(
      await readBranchContextEdits(path.join(editsDir, 'missing.jsonl')),
    ).toEqual([]);
    expect(await readBranchContextEdits(editsDir)).toEqual([]);
    expect(await readBranchContextEdits(undefined)).toEqual([]);
    expect(await readBranchContextEdits(null)).toEqual([]);

    const garbage = writeEdits('garbage.jsonl', ['not json at all']);
    expect(await readBranchContextEdits(garbage)).toEqual([]);
    const notAnEntry = writeEdits('array.jsonl', ['[{"type":"context_edit"}]']);
    expect(await readBranchContextEdits(notAnEntry)).toEqual([]);
    const empty = writeEdits('empty.jsonl', []);
    expect(await readBranchContextEdits(empty)).toEqual([]);
  });

  it('refuses a file past the read cap, leaving the projection alone', async () => {
    // This runs while a history snapshot is assembled, so the bound is latency, not memory: past it
    // the reader says "nothing", which is what an unedited session looks like to the caller.
    const filePath = writeEdits('huge.jsonl', [
      sessionLine('s10'),
      ...roundTrip(null),
      contextEditLine('e1', 'tr1', 'tr1', null),
      line({
        type: 'custom',
        id: 'x1',
        parentId: 'e1',
        timestamp: t(5),
        customType: 'blob',
        data: { blob: 'y'.repeat(16 * 1024 * 1024) },
      }),
    ]);
    expect(fs.statSync(filePath).size).toBeGreaterThan(16 * 1024 * 1024);
    expect(await readBranchContextEdits(filePath)).toEqual([]);
  });

  it('notices an edit appended after the last read', async () => {
    const filePath = writeEdits('grown.jsonl', [
      sessionLine('s11'),
      ...roundTrip(null),
      contextEditLine('e1', 'tr1', 'tr1', null),
    ]);
    // Pin the clock, then re-pin it after the append: an append always grows the file, so the size
    // is the term that has to invalidate the memo — a cached read keyed on the timestamp alone would
    // answer here with yesterday's single edit.
    const frozen = new Date(1_700_000_000_000);
    fs.utimesSync(filePath, frozen, frozen);

    const first = await readBranchContextEdits(filePath);
    expect(first.map((edit) => edit.targetId)).toEqual(['tr1']);
    expect(await readBranchContextEdits(filePath)).toBe(first);

    fs.appendFileSync(
      filePath,
      `${[
        // The new round continues from the edit itself: hang it off `tr1` and the omission would be
        // forked away with the line above it, and correctly disappear from the result.
        userLine('u2', 'e1', 'and the other one', 5),
        assistantLine('a2', 'u2', ['call_2'], 'looking', 6),
        toolResultLine('tr2', 'a2', 'call_2', 'SECOND OUTPUT', 7),
        contextEditLine('e2', 'tr2', 'tr2', null, 8),
      ].join('\n')}\n`,
      'utf8',
    );
    fs.utimesSync(filePath, frozen, frozen);
    expect(fs.statSync(filePath).mtimeMs).toBe(frozen.getTime());

    const second = await readBranchContextEdits(filePath);
    expect(second.map((edit) => edit.targetId)).toEqual(['tr1', 'tr2']);
    expect(second).not.toBe(first);
  });
});

describe('the readers a context edit must not disturb', () => {
  /**
   * A session that has compacted, forked and been edited: 6 message lines, 2 compactions (one of
   * them on the abandoned branch), a usage row and the edits the caller hands in.
   */
  const mixedLines = (edits: string[]) => [
    sessionLine('s12', '/repo'),
    ...roundTrip(null),
    compactionLine('c1', 'tr1', 'u2', 4),
    userLine('u2', 'c1', 'and again', 5),
    assistantLine('a2', 'u2', ['call_2'], 'looking', 6),
    toolResultLine('tr2', 'a2', 'call_2', 'LIVE OUTPUT', 7),
    // A boundary of the run the user forked away from.
    compactionLine('c_old', 'a1', 'a1', 8),
    line({
      type: 'usage',
      id: 'us1',
      parentId: 'tr2',
      timestamp: t(9),
      kind: 'assistant',
      provider: 'anthropic',
      model: 'claude',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
      },
    }),
    ...edits,
  ];

  const liveEdits = [
    contextEditLine('e1', 'us1', 'tr1', null, 10),
    contextEditLine(
      'e2',
      'e1',
      'tr2',
      {
        content: [{ type: 'text', text: 'NEW' }],
      },
      11,
    ),
  ];

  it('reads the same boundaries with the edits in the file', async () => {
    const edited = writeEdits('mixed.jsonl', mixedLines(liveEdits));
    const plain = writeEdits('mixed-plain.jsonl', mixedLines([]));

    // The boundaries of the branch the file ends on, edits or no edits, and never the one the fork
    // left behind: that is what `readBranchCompactions` answered before this feature existed.
    expect(readBranchCompactions(edited).map((entry) => entry.id)).toEqual([
      'c1',
    ]);
    expect(readBranchCompactions(edited)).toEqual(readBranchCompactions(plain));
    expect(
      (await readBranchContextEdits(edited)).map((edit) => edit.targetId),
    ).toEqual(['tr1', 'tr2']);
  });

  it('counts only messages when it lists a session', () => {
    const agentDir = path.join(editsDir, 'agent');
    const projectDir = path.join(editsDir, 'repo');
    const sessions = sessionsDirForCwd(agentDir, projectDir);
    fs.mkdirSync(sessions, { recursive: true });
    const filePath = path.join(sessions, 'mixed-for-list.jsonl');
    fs.writeFileSync(filePath, `${mixedLines(liveEdits).join('\n')}\n`, 'utf8');

    // Nine entries, six of them messages. `messageCount` is a message count, so the two edits, the
    // two compactions and the usage row must not age the session in the history browser.
    const listed = listSessions(agentDir, projectDir, filePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 's12',
      messageCount: 6,
      firstMessage: 'read the file',
      current: true,
    });
  });
});
