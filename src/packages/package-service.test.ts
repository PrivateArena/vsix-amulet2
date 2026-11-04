import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PiConfig } from '../config';
import {
  listPackages,
  packagesFingerprintOf,
  runPackageCommand,
  togglePackage,
} from './package-service';
import type { PackageDirs } from './package-catalog';

/**
 * The five operations, on both of their mechanisms: the two that edit a settings file and the two
 * that must not be anything but the real `pi` subcommand. The fake binary is the same trick
 * `pi-updater.test.ts` uses — a shell stub that prints its argv, so the flags are asserted rather
 * than trusted.
 */

const config = (binaryPath: string): PiConfig => ({
  binaryPath,
  agentDir: '',
  defaultModel: '',
  thinkingLevel: 'medium',
  autoCompact: true,
  autoRetry: true,
  expandThinking: false,
  extraArgs: [],
});

/** Absolute path to an executable stub standing in for the global `pi`. */
function fakePi(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'amulet-package-cli-'));
  const file = join(dir, 'pi');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A fresh pair of scope roots, with nothing declared in either. */
function freshDirs(): PackageDirs & { userFile: string; projectFile: string } {
  const agentDir = mkdtempSync(join(tmpdir(), 'amulet-package-agent-'));
  const cwd = mkdtempSync(join(tmpdir(), 'amulet-package-cwd-'));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  return {
    agentDir,
    cwd,
    userFile: join(agentDir, 'settings.json'),
    projectFile: join(cwd, '.pi', 'settings.json'),
  };
}

const unix = process.platform === 'win32' ? describe.skip : describe;

unix('runPackageCommand', () => {
  it('installs into the user scope without letting pi run project extensions', async () => {
    const dirs = freshDirs();
    const result = await runPackageCommand({
      config: config(fakePi('echo "args: $*"')),
      dirs,
      op: 'install',
      source: 'npm:demo',
      scope: 'user',
      opId: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.op).toBe('install');
    // `-na`: without an explicit answer, `pi install` would load and execute this folder's
    // extensions just to work out whether it may write a user-scope file.
    expect(result.output).toContain('install npm:demo -na');
  });

  it('installs into the project scope through -l, which needs the approve flag', async () => {
    const result = await runPackageCommand({
      config: config(fakePi('echo "args: $*"')),
      dirs: freshDirs(),
      op: 'install',
      source: './local/pkg',
      scope: 'project',
      opId: 3,
    });

    expect(result.output).toContain('install ./local/pkg -l -a');
  });

  it('removes with the declaration exactly as it was stored', async () => {
    const result = await runPackageCommand({
      config: config(fakePi('echo "args: $*"; exit 0')),
      dirs: freshDirs(),
      op: 'remove',
      source: 'git:github.com/o/r@v1',
      scope: 'user',
      opId: 3,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('remove git:github.com/o/r@v1 -na');
  });

  it('passes a failing exit code and the registry output through', async () => {
    const result = await runPackageCommand({
      config: config(fakePi('echo "npm ERR! 404" >&2; exit 1')),
      dirs: freshDirs(),
      op: 'install',
      source: 'npm:nope',
      scope: 'user',
      opId: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('404');
  });

  it('refuses a source that would read as a flag, without spawning', async () => {
    const result = await runPackageCommand({
      config: config(fakePi('echo SHOULD_NOT_RUN')),
      dirs: freshDirs(),
      op: 'install',
      source: '-l',
      scope: 'user',
      opId: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('cannot start with');
  });
});

describe('togglePackage', () => {
  it('writes the user file and leaves every other setting alone', () => {
    const dirs = freshDirs();
    writeFileSync(
      dirs.userFile,
      JSON.stringify({ theme: 'dark', packages: ['npm:demo'] }, null, 2),
      'utf8',
    );

    const result = togglePackage({
      dirs,
      source: 'npm:demo',
      index: 0,
      scope: 'user',
      enabled: false,
      opId: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.op).toBe('disable');
    expect(read(dirs.userFile).theme).toBe('dark');
  });

  it('will not write a project declaration the runtime would not read', () => {
    const dirs = freshDirs();
    writeFileSync(
      dirs.projectFile,
      JSON.stringify({ packages: ['npm:demo'] }),
      'utf8',
    );

    const result = togglePackage({
      dirs,
      source: 'npm:demo',
      index: 0,
      scope: 'project',
      enabled: false,
      opId: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('trusted');
  });
});

describe('listPackages', () => {
  it('lists both scopes and says when the runtime is behind the files', () => {
    const dirs = freshDirs();
    writeFileSync(
      dirs.userFile,
      JSON.stringify({ packages: ['npm:demo'] }),
      'utf8',
    );

    const first = listPackages({ dirs, baseline: null, requestId: 7 });
    expect(first.requestId).toBe(7);
    expect(first.packages).toHaveLength(1);
    expect(first.packages[0]).toMatchObject({ scope: 'user', name: 'demo' });
    // Nothing was known about what the runtime loaded, so nothing may be claimed about it.
    expect(first.reloadRequired).toBe(false);

    const baseline = packagesFingerprintOf(dirs);
    writeFileSync(
      dirs.userFile,
      JSON.stringify({ packages: ['npm:demo', 'npm:other'] }),
      'utf8',
    );
    writeFileSync(
      dirs.projectFile,
      JSON.stringify({ packages: ['git:github.com/o/r'] }),
      'utf8',
    );

    const second = listPackages({ dirs, baseline, requestId: 8 });
    expect(second.reloadRequired).toBe(true);
    expect(second.packages.map((p) => p.scope)).toEqual([
      'user',
      'user',
      'project',
    ]);
    expect(second.projectTrusted).toBe(false);
  });

  it('marks the declaration pi will not act on, by package identity', () => {
    const dirs = freshDirs();
    writeFileSync(
      dirs.userFile,
      JSON.stringify({ packages: ['npm:foo', 'npm:foo@1.2.3', 'npm:bar'] }),
      'utf8',
    );
    writeFileSync(
      dirs.projectFile,
      JSON.stringify({ packages: ['npm:bar@2'] }),
      'utf8',
    );

    const rows = listPackages({ dirs, baseline: null, requestId: 1 }).packages;
    const rowOf = (scope: string, source: string) =>
      rows.find((row) => row.scope === scope && row.source === source);

    // Same identity twice in one file: pi keeps the first, so only the first is actionable.
    expect(rowOf('user', 'npm:foo')?.shadowed).toBeUndefined();
    expect(rowOf('user', 'npm:foo@1.2.3')?.shadowed).toContain(
      'earlier declaration',
    );

    // A project declaration of a package also declared by the user replaces the user one: pi resolves
    // project-first, so the user row is the inert one even though it is listed first.
    expect(rowOf('project', 'npm:bar@2')?.shadowed).toBeUndefined();
    expect(rowOf('user', 'npm:bar')?.shadowed).toContain('project declaration');
  });

  it('surfaces an unreadable settings file as an error row set', () => {
    const dirs = freshDirs();
    writeFileSync(dirs.userFile, '{ not json', 'utf8');

    const result = listPackages({ dirs, baseline: null, requestId: 1 });
    expect(result.packages).toEqual([]);
    expect(result.errors.join(' ')).toContain('settings.json');
  });
});

function read(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}
