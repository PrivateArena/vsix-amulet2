import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlIdOf, menuItemId } from './control-id';

const WEBVIEW_SRC = join(__dirname, '..');

/** Every JSX/TSX source of the webview bundle, tests and comments excluded. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx')
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Every literal `id="…"` in the webview, with its `file:line`. */
function literalIds(): { id: string; at: string }[] {
  const ids: { id: string; at: string }[] = [];
  for (const file of sourceFiles(WEBVIEW_SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A comment that quotes a selector is documentation, not a control.
      if (/^\s*(\*|\/\/)/.test(line)) return;
      for (const [, id] of line.matchAll(/\sid="([a-z0-9][a-z0-9-]*)"/g)) {
        ids.push({ id, at: `${relative(WEBVIEW_SRC, file)}:${i + 1}` });
      }
    });
  }
  return ids;
}

describe('control-id', () => {
  it('turns a hover name into a css id', () => {
    expect(controlIdOf('Sticky approval alerts')).toBe(
      'sticky-approval-alerts',
    );
    expect(controlIdOf('Send (Enter)')).toBe('send-enter');
    expect(controlIdOf('  Pi   packages  ')).toBe('pi-packages');
    expect(controlIdOf('···')).toBe('');
  });

  it('names a menu item under its menu, and honours a stable override', () => {
    expect(menuItemId('preferences-menu', { label: 'Privacy mode' })).toBe(
      'preferences-menu-privacy-mode',
    );
    // The label of this one carries a rule count, so the id may not follow it.
    expect(
      menuItemId('preferences-menu', {
        label: 'Privacy mode (2 rules unusable)',
        id: 'privacy-mode',
      }),
    ).toBe('preferences-menu-privacy-mode');
    expect(menuItemId('preferences-menu', { label: '···' })).toBe(
      'preferences-menu',
    );
  });

  it('gives each literal id to exactly one control', () => {
    const seen = new Map<string, string[]>();
    for (const { id, at } of literalIds()) {
      seen.set(id, [...(seen.get(id) ?? []), at]);
    }
    const duplicated = [...seen]
      .filter(([, places]) => places.length > 1)
      .map(([id, places]) => `${id}: ${places.join(', ')}`);
    expect(duplicated).toEqual([]);
  });
});
