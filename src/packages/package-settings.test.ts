import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isAutoloadDisabled,
  hasResourceFilters,
  packagesFingerprint,
  readPackagesFile,
  resolveProjectTrust,
  setPackageEnabled,
  sourceOf,
} from './package-settings';

/**
 * The settings-file half of the package manager: what pi declared, and the smallest edit that flips
 * it. Everything here is plain JSON, so the rules pi's own `pi config` TUI follows are checkable
 * without pi, without VS Code and without the network.
 */

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'amulet-pkg-settings-'));
}

function writeSettings(file: string, settings: unknown): void {
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}

describe('readPackagesFile', () => {
  it('treats a missing file as an empty list, not an error', () => {
    const file = join(dir(), 'settings.json');
    const result = readPackagesFile(file);
    expect(result.exists).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('returns the declarations verbatim, in both pi forms', () => {
    const file = join(dir(), 'settings.json');
    writeSettings(file, {
      theme: 'dark',
      packages: ['npm:a', { source: 'npm:b', autoload: false }],
    });

    const result = readPackagesFile(file);
    expect(result.exists).toBe(true);
    expect(result.entries).toEqual([
      'npm:a',
      { source: 'npm:b', autoload: false },
    ]);
    expect(sourceOf(result.entries[1])).toBe('npm:b');
    expect(isAutoloadDisabled(result.entries[0])).toBe(false);
    expect(isAutoloadDisabled(result.entries[1])).toBe(true);
  });

  it('reports a file it cannot parse instead of pretending it is empty', () => {
    const file = join(dir(), 'settings.json');
    writeFileSync(file, '{ "packages": [', 'utf8');

    const result = readPackagesFile(file);
    expect(result.entries).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('reports a packages field that is not an array', () => {
    const file = join(dir(), 'settings.json');
    writeSettings(file, { packages: 'npm:a' });

    const result = readPackagesFile(file);
    expect(result.error).toContain('not an array');
  });

  it('fingerprints content rather than bytes', () => {
    const base = dir();
    const a = join(base, 'a.json');
    const b = join(base, 'b.json');
    writeSettings(a, {
      theme: 'dark',
      packages: [{ source: 'npm:a', autoload: false }],
    });
    // Same declarations, different key order and different unrelated settings.
    writeSettings(b, {
      packages: [{ autoload: false, source: 'npm:a' }],
      theme: 'light',
    });

    expect(packagesFingerprint([readPackagesFile(a)])).toBe(
      packagesFingerprint([readPackagesFile(b)]),
    );

    writeSettings(b, { packages: ['npm:a'] });
    expect(packagesFingerprint([readPackagesFile(a)])).not.toBe(
      packagesFingerprint([readPackagesFile(b)]),
    );
  });
});

describe('setPackageEnabled', () => {
  let file: string;

  beforeEach(() => {
    file = join(dir(), 'settings.json');
  });

  it('disables a string declaration the way pi writes it', () => {
    writeSettings(file, {
      theme: 'dark',
      packages: ['npm:pi-ssh-remote', 'git:github.com/o/r'],
    });

    const result = setPackageEnabled(file, {
      source: 'npm:pi-ssh-remote',
      index: 0,
      enabled: false,
    });
    expect(result).toEqual({ ok: true, changed: true });

    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.packages[0]).toEqual({
      source: 'npm:pi-ssh-remote',
      autoload: false,
    });
    expect(written.packages[1]).toBe('git:github.com/o/r');
    // pi's writer keeps the file's other keys and its 2-space shape.
    expect(written.theme).toBe('dark');
    expect(readFileSync(file, 'utf8')).toContain('\n  "theme": "dark"');
  });

  it('re-enabling a filtered declaration back to plain form only when nothing is left', () => {
    writeSettings(file, {
      packages: [{ source: 'npm:a', autoload: false, skills: ['skills/*.md'] }],
    });

    expect(
      setPackageEnabled(file, { source: 'npm:a', index: 0, enabled: true }).ok,
    ).toBe(true);
    let written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.packages[0]).toEqual({
      source: 'npm:a',
      skills: ['skills/*.md'],
    });
    expect(hasResourceFilters(written.packages[0])).toBe(true);

    writeSettings(file, { packages: [{ source: 'npm:b', autoload: false }] });
    expect(
      setPackageEnabled(file, { source: 'npm:b', index: 0, enabled: true }).ok,
    ).toBe(true);
    written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.packages[0]).toBe('npm:b');
  });

  it('does not rewrite a file that already says what was asked', () => {
    writeSettings(file, { packages: [{ source: 'npm:a', autoload: false }] });
    const before = readFileSync(file, 'utf8');

    expect(
      setPackageEnabled(file, { source: 'npm:a', index: 0, enabled: false }),
    ).toEqual({
      ok: true,
      changed: false,
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a source it cannot find, and a file it cannot parse', () => {
    writeSettings(file, { packages: ['npm:a'] });
    expect(
      setPackageEnabled(file, {
        source: 'npm:missing',
        index: 5,
        enabled: false,
      }).ok,
    ).toBe(false);

    const broken = join(dir(), 'broken.json');
    writeFileSync(broken, 'nope', 'utf8');
    expect(
      setPackageEnabled(broken, { source: 'npm:a', index: 0, enabled: false })
        .error,
    ).toBeTruthy();
  });
});

describe('resolveProjectTrust', () => {
  it('applies the nearest stored decision, as pi does', () => {
    const agentDir = dir();
    const root = join(dir(), 'project');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(
      join(agentDir, 'trust.json'),
      JSON.stringify({ [root]: true }),
      'utf8',
    );

    const dirs = { agentDir, cwd: join(root, 'sub') };
    expect(resolveProjectTrust(dirs)).toEqual({
      trusted: true,
      decision: true,
    });
  });

  it('trusts a folder with nothing to trust, which is how a first project install happens', () => {
    const dirs = { agentDir: dir(), cwd: join(dir(), 'plain-project') };
    mkdirSync(dirs.cwd, { recursive: true });
    expect(resolveProjectTrust(dirs)).toEqual({
      trusted: true,
      decision: null,
    });

    // The moment the folder has a `.pi/settings.json`, pi needs an explicit decision — so a project
    // declaration in a folder nobody trusted is reported as inert rather than as loaded.
    mkdirSync(join(dirs.cwd, '.pi'), { recursive: true });
    writeFileSync(join(dirs.cwd, '.pi', 'settings.json'), '{}', 'utf8');
    expect(resolveProjectTrust(dirs).trusted).toBe(false);
  });
});
