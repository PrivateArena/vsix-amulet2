import { describe, expect, it } from 'vitest';
import {
  directoryEntries,
  mentionInsertion,
  parseAtToken,
  rankFileMentions,
  normalizeMentionQuery,
  toFileMention,
} from './at-mention';

const TREE = [
  'AGENTS.md',
  'README.md',
  'docs/rpc-commands.md',
  'src/webview/chat-bridge.ts',
  'src/webview/project-files.ts',
  'src/webview/project-paths.ts',
  'src/rpc/rpc-client.ts',
  'webview/src/store.ts',
  'webview/src/components/store.ts',
  'webview/src/utils/at-mention.ts',
];

describe('parseAtToken', () => {
  it('detects a token at the end of the input and keeps slashes in it', () => {
    expect(parseAtToken('@')).toEqual({ query: '', start: 0, end: 1 });
    expect(parseAtToken('look at @src/webview/ch')).toEqual({
      query: 'src/webview/ch',
      start: 8,
      end: 23,
    });
  });

  it('requires the @ to open a word', () => {
    expect(parseAtToken('mail me at gunir@example')).toBeNull();
    expect(parseAtToken('path/to/@file')).toBeNull();
  });

  it('ignores a token that is not at the end', () => {
    expect(parseAtToken('@src/store.ts read it')).toBeNull();
    expect(parseAtToken('fix the build')).toBeNull();
    expect(parseAtToken('')).toBeNull();
  });
});

describe('normalizeMentionQuery', () => {
  it('treats a leading slash or ./ as the project root', () => {
    expect(normalizeMentionQuery('/src/web')).toBe('src/web');
    expect(normalizeMentionQuery('./src/web')).toBe('src/web');
    expect(normalizeMentionQuery('SRC/Web')).toBe('src/web');
  });
});

describe('toFileMention', () => {
  it('splits a path into the pieces a row renders', () => {
    expect(toFileMention('src/webview/chat-bridge.ts')).toEqual({
      path: 'src/webview/chat-bridge.ts',
      name: 'chat-bridge.ts',
      dir: 'src/webview',
      kind: 'file',
    });
    expect(toFileMention('README.md').dir).toBe('');
  });
});

describe('directoryEntries', () => {
  it('lists the root children for a bare @', () => {
    expect(directoryEntries(TREE, '').map((e) => e.path)).toEqual([
      'docs/',
      'src/',
      'webview/',
      'AGENTS.md',
      'README.md',
    ]);
  });

  it('collapses nested paths into the next segment down', () => {
    expect(directoryEntries(TREE, 'src/').map((e) => e.path)).toEqual([
      'src/rpc/',
      'src/webview/',
    ]);
    expect(directoryEntries(TREE, 'src/webview/').map((e) => e.path)).toEqual([
      'src/webview/chat-bridge.ts',
      'src/webview/project-files.ts',
      'src/webview/project-paths.ts',
    ]);
  });

  it('marks directories so the caller can insert without a trailing space', () => {
    const [docs] = directoryEntries(TREE, '');
    expect(docs).toMatchObject({ path: 'docs/', kind: 'dir', name: 'docs/' });
  });
});

describe('mentionInsertion', () => {
  it('spaces a file and leaves a directory open for descent', () => {
    expect(mentionInsertion(toFileMention('src/store.ts'))).toBe(
      '@src/store.ts ',
    );
    expect(
      mentionInsertion({
        path: 'src/webview/',
        name: 'webview/',
        dir: 'src',
        kind: 'dir',
      }),
    ).toBe('@src/webview/');
  });

  it('quotes a path with whitespace, or half of it reaches pi as prose', () => {
    expect(mentionInsertion(toFileMention('docs/my report.md'))).toBe(
      "@'docs/my report.md' ",
    );
  });
});

describe('rankFileMentions', () => {
  it('navigates on a trailing slash instead of searching', () => {
    expect(rankFileMentions(TREE, 'src/').map((e) => e.path)).toEqual([
      'src/rpc/',
      'src/webview/',
    ]);
  });

  it('ranks a path typed from the root above a name match', () => {
    const ranked = rankFileMentions(TREE, 'src/webview/pro').map((e) => e.path);
    expect(ranked).toEqual([
      'src/webview/project-files.ts',
      'src/webview/project-paths.ts',
    ]);
  });

  it('prefers a file-name prefix over a substring, and a substring over a directory hit', () => {
    expect(rankFileMentions(TREE, 'store').map((e) => e.path)).toEqual([
      'webview/src/store.ts',
      'webview/src/components/store.ts',
    ]);
    expect(rankFileMentions(TREE, 'bridge').map((e) => e.path)).toEqual([
      'src/webview/chat-bridge.ts',
    ]);
  });

  it('orders same-score matches shallow-first, then shortest', () => {
    const ranked = rankFileMentions(
      ['a/b/store.ts', 'a/store.ts', 'a/b/c/store.ts'],
      'store',
    ).map((e) => e.path);
    expect(ranked).toEqual(['a/store.ts', 'a/b/store.ts', 'a/b/c/store.ts']);
  });

  it('caps the list so the menu stays scannable', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    expect(rankFileMentions(many, 'src/', 5).length).toBeLessThanOrEqual(5);
    expect(rankFileMentions(many, 'f', 3).length).toBe(3);
  });

  it('offers a directory whose name is only half typed', () => {
    const ranked = rankFileMentions(TREE, 'webvi').map((e) => e.path);
    expect(ranked[0]).toBe('webview/');
    expect(ranked).toContain('webview/src/store.ts');
    // ...and both kinds at once when the query reaches into it.
    expect(rankFileMentions(TREE, 'src/web').map((e) => e.path)).toEqual([
      'src/webview/',
      'src/webview/chat-bridge.ts',
      'src/webview/project-files.ts',
      'src/webview/project-paths.ts',
    ]);
  });

  it('never lets directories crowd the files out of the list', () => {
    const deep = Array.from(
      { length: 60 },
      (_, i) => `big/dir${i}/keep.ts`,
    ).concat('big/important.md');
    const ranked = rankFileMentions(deep, 'big', 10);
    expect(ranked.some((e) => e.kind === 'dir')).toBe(true);
    expect(ranked.some((e) => e.path === 'big/important.md')).toBe(true);
  });

  it('returns nothing when no path matches', () => {
    expect(rankFileMentions(TREE, 'nope')).toEqual([]);
  });
});
