import { describe, expect, it } from 'vitest';
import type { PackageEntry } from '../../../../../shared/protocol';
import {
  emptyStateText,
  filterPackages,
  kindCounts,
  operationAlert,
  toneOf,
} from './packages-view';

function entry(overrides: Partial<PackageEntry> = {}): PackageEntry {
  return {
    source: 'npm:demo',
    scope: 'user',
    index: 0,
    kind: 'npm',
    name: 'demo',
    identity: 'npm:demo',
    enabled: true,
    filtered: false,
    hasFilters: false,
    installed: true,
    ...overrides,
  };
}

const rows = [
  entry({ source: 'npm:one', name: 'one', description: 'MCP transport' }),
  entry({
    source: 'npm:two',
    name: 'two',
    resourceKinds: ['skills'],
    author: 'nicopreme',
  }),
  entry({
    source: 'git:github.com/o/three',
    name: 'three',
    scope: 'project',
    enabled: false,
    resourceKinds: ['extensions', 'themes'],
  }),
];

describe('filterPackages', () => {
  it('keeps everything on an empty filter', () => {
    expect(filterPackages(rows, { text: '', kind: 'all' })).toHaveLength(3);
  });

  it('matches name, source, description and author, case-insensitively', () => {
    expect(
      filterPackages(rows, { text: ' MCP ', kind: 'all' }).map((r) => r.name),
    ).toEqual(['one']);
    expect(
      filterPackages(rows, { text: 'GIT:', kind: 'all' }).map((r) => r.name),
    ).toEqual(['three']);
    expect(
      filterPackages(rows, { text: 'nicopreme', kind: 'all' }).map(
        (r) => r.name,
      ),
    ).toEqual(['two']);
  });

  it('applies the kind chip on top of the text', () => {
    expect(
      filterPackages(rows, { text: '', kind: 'extensions' }).map((r) => r.name),
    ).toEqual(['three']);
    expect(
      filterPackages(rows, { text: 'e', kind: 'skills' }).map((r) => r.name),
    ).toEqual(['two']);
    // A row with no resources on disk is in no chip at all.
    expect(filterPackages(rows, { text: '', kind: 'prompts' })).toEqual([]);
  });
});

describe('kindCounts', () => {
  it('counts the unfiltered list, so a chip never contradicts itself', () => {
    expect(kindCounts(rows)).toEqual({
      all: 3,
      extensions: 1,
      skills: 1,
      prompts: 0,
      themes: 1,
    });
  });
});

describe('operationAlert', () => {
  it('says nothing about an instant toggle that worked', () => {
    expect(
      operationAlert({ op: 'enable', opId: 1, source: 'npm:demo', ok: true }),
    ).toBeNull();
  });

  it('reports a slow operation that worked', () => {
    expect(
      operationAlert({ op: 'install', opId: 1, source: 'npm:demo', ok: true })
        ?.text,
    ).toBe('Installed npm:demo.');
  });

  it('quotes the verdict line of a failed command, not its log', () => {
    const alert = operationAlert({
      op: 'install',
      opId: 1,
      source: 'npm:nope',
      ok: false,
      exitCode: 1,
      output:
        'npm WARN deprecated x\nnpm ERR! code E404\nError: npm install failed',
    });
    expect(alert?.level).toBe('error');
    expect(alert?.text).toBe(
      'Installing npm:nope failed — Error: npm install failed.',
    );
  });

  it('calls a cancelled command cancelled', () => {
    expect(
      operationAlert({
        op: 'remove',
        opId: 1,
        source: 'npm:demo',
        ok: false,
        cancelled: true,
      })?.text,
    ).toBe('Removing npm:demo cancelled.');
  });
});

describe('emptyStateText', () => {
  it('distinguishes "nothing installed" from "nothing matched"', () => {
    expect(emptyStateText(null, { text: '', kind: 'all' })).toContain(
      'Reading',
    );
    expect(
      emptyStateText({ packages: [], errors: [] } as never, {
        text: '',
        kind: 'all',
      }),
    ).toContain('No pi packages');
    expect(
      emptyStateText({ packages: rows } as never, { text: 'zzz', kind: 'all' }),
    ).toContain('No package matches');
  });
});

describe('toneOf', () => {
  it('is stable and in range', () => {
    expect(toneOf('demo')).toBe(toneOf('demo'));
    for (const name of ['a', 'demo', 'pi-mcp-extension', '@scope/name']) {
      expect(toneOf(name)).toBeGreaterThanOrEqual(0);
      expect(toneOf(name)).toBeLessThan(6);
    }
  });
});
