import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBranchCompactions } from './session-store';

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
