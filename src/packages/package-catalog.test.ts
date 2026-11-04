import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  npmPackageName,
  packageRows,
  parseGitSource,
  parsePackageSource,
} from './package-catalog';
import { readPackagesFile } from './package-settings';

/**
 * Source strings to rows. The expectations are the paths pi itself uses (`pi list` prints the same
 * ones), because a row that points anywhere else is a row that says "not installed" about a package
 * pi loads fine.
 */

const agentDir = mkdtempSync(join(tmpdir(), 'amulet-pkg-agent-'));
const cwd = mkdtempSync(join(tmpdir(), 'amulet-pkg-cwd-'));
const dirs = { agentDir, cwd };
const userSettings = join(agentDir, 'settings.json');

describe('npmPackageName', () => {
  it('cuts the version range off, with and without a scope', () => {
    expect(npmPackageName('pi-ssh-remote')).toBe('pi-ssh-remote');
    expect(npmPackageName('pi-ssh-remote@1.2.3')).toBe('pi-ssh-remote');
    expect(npmPackageName('pi-ssh-remote@^1.2')).toBe('pi-ssh-remote');
    expect(npmPackageName('@scope/name')).toBe('@scope/name');
    expect(npmPackageName('@scope/name@2.0.0')).toBe('@scope/name');
  });
});

describe('parseGitSource', () => {
  it('reads every shape pi accepts and stores it as host/path', () => {
    expect(parseGitSource('git:github.com/PrivateArena/pi-disciple')).toEqual({
      host: 'github.com',
      path: 'PrivateArena/pi-disciple',
      repository: 'pi-disciple',
    });
    expect(parseGitSource('git:github.com/user/repo@v1.2.3')?.path).toBe(
      'user/repo',
    );
    expect(parseGitSource('https://github.com/user/repo.git')?.path).toBe(
      'user/repo',
    );
    expect(parseGitSource('git:git@github.com:user/repo')).toEqual({
      host: 'github.com',
      path: 'user/repo',
      repository: 'repo',
    });
    expect(parseGitSource('ssh://git@gitlab.com/group/project')).toEqual({
      host: 'gitlab.com',
      path: 'group/project',
      repository: 'project',
    });
  });

  it('is null for anything that is not a git source', () => {
    expect(parseGitSource('./local/path')).toBeNull();
    expect(parseGitSource('npm:name')).toBeNull();
    expect(parseGitSource('github.com/user/repo')).toBeNull();
  });
});

describe('parsePackageSource', () => {
  it('resolves an npm source under the agent dir', () => {
    expect(
      parsePackageSource('npm:pi-ssh-remote@1.0.0', userSettings, dirs, 'user'),
    ).toEqual({
      kind: 'npm',
      name: 'pi-ssh-remote',
      identity: 'npm:pi-ssh-remote',
      installedPath: join(agentDir, 'npm', 'node_modules', 'pi-ssh-remote'),
    });
  });

  it('resolves a project-scope npm source under .pi', () => {
    expect(
      parsePackageSource(
        'npm:x',
        join(cwd, '.pi', 'settings.json'),
        dirs,
        'project',
      ).installedPath,
    ).toBe(join(cwd, '.pi', 'npm', 'node_modules', 'x'));
  });

  it('resolves a git checkout by host and path, ref dropped', () => {
    expect(
      parsePackageSource('git:github.com/o/r@main', userSettings, dirs, 'user'),
    ).toEqual({
      kind: 'git',
      name: 'r',
      identity: 'git:github.com/o/r',
      installedPath: join(agentDir, 'git', 'github.com', 'o', 'r'),
    });
  });

  it('resolves a relative local path from the settings file that declares it', () => {
    const parsed = parsePackageSource('../../pkg', userSettings, dirs, 'user');
    expect(parsed.kind).toBe('local');
    expect(parsed.installedPath).toBe(join(agentDir, '..', '..', 'pkg'));
    expect(parsed.name).toBe('pkg');
  });

  it('treats an unrecognised source as a path, which is what pi does', () => {
    expect(
      parsePackageSource('weird-thing', userSettings, dirs, 'user').kind,
    ).toBe('local');
  });
});

describe('packageRows', () => {
  function rowsOf(packages: unknown[]) {
    const file = join(
      agentDir,
      `settings-${Math.random().toString(36).slice(2)}.json`,
    );
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ packages }, null, 2), 'utf8');
    return packageRows(readPackagesFile(file), 'user', dirs);
  }

  it('marks a disabled declaration as an object form that is off but still filtered', () => {
    const [row] = rowsOf([{ source: 'npm:absent', autoload: false }]);
    expect(row.enabled).toBe(false);
    expect(row.filtered).toBe(true);
    expect(row.installed).toBe(false);
    expect(row.error).toContain('Not installed');
  });

  it('reads metadata and offered resource kinds off the installed package', () => {
    const root = join(agentDir, 'npm', 'node_modules', 'demo');
    mkdirSync(join(root, 'extensions'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.4.0',
        description: 'A demo package',
        author: { name: 'someone' },
      }),
      'utf8',
    );
    writeFileSync(
      join(root, 'extensions', 'demo.ts'),
      'export default 1;\n',
      'utf8',
    );

    const [row] = rowsOf(['npm:demo']);
    expect(row).toMatchObject({
      name: 'demo',
      enabled: true,
      filtered: false,
      installed: true,
      version: '1.4.0',
      description: 'A demo package',
      author: 'someone',
      resourceKinds: ['extensions'],
    });
    expect(row.error).toBeUndefined();
  });

  it('honours a pi manifest that declares resources elsewhere', () => {
    const root = join(agentDir, 'npm', 'node_modules', 'declared');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'declared',
        pi: { skills: ['resources/skills'] },
      }),
      'utf8',
    );

    expect(rowsOf(['npm:declared'])[0].resourceKinds).toEqual(['skills']);
  });

  it('keeps an unrecognised entry visible instead of dropping it', () => {
    const [row] = rowsOf([42]);
    expect(row.name).toBe('(unrecognised entry)');
    expect(row.error).toContain('Not a package source');
  });
});
