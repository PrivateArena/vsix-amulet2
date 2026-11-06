import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PiConfig } from '../config';
import { buildStartupArgs } from './bootstrap';
import {
  BRIDGE_BUNDLE_REL_PATH,
  MIN_PI_VERSION_FOR_BRIDGE,
  bridgeExtensionPath,
  bridgeSpawnArgs,
  supportsBridge,
} from './bridge-args';

/**
 * How the bridge gets into the child process, which is the whole of stage S1a: a `-e` flag naming a
 * file that is really there, and nothing else. Every case below is one of the three reasons the flag
 * is *not* added — the setting is off, the runtime is too old, the bundle is missing — because a wrong
 * `-e` costs the child at startup while a missing one only costs a feature.
 *
 * `bridgeSpawnArgs` stats the disk, so the positive case runs against a real temp extension dir with a
 * stub bundle inside it rather than against a path nobody can open.
 */
function config(overrides: Partial<PiConfig> = {}): PiConfig {
  return {
    binaryPath: 'pi',
    agentDir: '',
    defaultModel: '',
    thinkingLevel: 'disabled',
    autoCompact: true,
    autoRetry: true,
    expandThinking: false,
    privacyMode: false,
    privacyRules: [],
    contextEditing: true,
    extraArgs: [],
    ...overrides,
  };
}

const dirs: string[] = [];

/** A temp directory standing in for the installed extension, bundle included on request. */
function fakeExtensionDir(withBundle: boolean = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'amulet-bridge-'));
  dirs.push(dir);
  if (withBundle) {
    const bundle = bridgeExtensionPath(dir);
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(
      bundle,
      'export default function amuletBridge() {}\n',
      'utf8',
    );
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('supportsBridge', () => {
  it('accepts the versions the bridge was verified against', () => {
    expect(supportsBridge('1.4.0')).toBe(true);
    expect(supportsBridge('1.5.0')).toBe(true);
    expect(supportsBridge('1.10.0')).toBe(true);
    expect(supportsBridge('v1.5.0-beta.1')).toBe(true);
  });

  it('rejects the pre-1.4 runtime that has no context_edit', () => {
    expect(supportsBridge('0.80.3')).toBe(false);
    expect(supportsBridge('1.3.9')).toBe(false);
  });

  it('reads a partial version as major.minor', () => {
    expect(supportsBridge('1.4')).toBe(true);
    expect(supportsBridge('0.80')).toBe(false);
  });

  it('treats an unreadable version as unsupported', () => {
    expect(supportsBridge('')).toBe(false);
    expect(supportsBridge('unknown')).toBe(false);
  });

  it('keeps the floor the plan states', () => {
    expect(MIN_PI_VERSION_FOR_BRIDGE).toBe('1.4.0');
  });
});

describe('bridgeExtensionPath', () => {
  it('points inside the extension dir at the bridge bundle', () => {
    const root = join('/home', 'u', '.vscode', 'extensions', 'amulet');
    // Derived from the constant, so the bundle's name is stated exactly once: what esbuild writes,
    // what the path resolver returns, and what this test asserts.
    expect(bridgeExtensionPath(root)).toBe(
      join(root, ...BRIDGE_BUNDLE_REL_PATH.split('/')),
    );
    expect(BRIDGE_BUNDLE_REL_PATH).toBe('dist/pi-bridge/amulet-bridge.mjs');
  });

  it('is the file the spawn args name', () => {
    const dir = fakeExtensionDir();
    const path = bridgeExtensionPath(dir);
    expect(path.startsWith(dir)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe('bridgeSpawnArgs', () => {
  it('adds -e with the bundle path when everything is in place', () => {
    const dir = fakeExtensionDir();
    const log = vi.fn();

    const args = bridgeSpawnArgs({
      extensionDir: dir,
      enabled: true,
      agentVersion: '1.5.0',
      log,
    });

    expect(args).toEqual(['-e', bridgeExtensionPath(dir)]);
    expect(existsSync(args[1])).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('stays out of argv while the setting is off', () => {
    const dir = fakeExtensionDir();
    expect(
      bridgeSpawnArgs({
        extensionDir: dir,
        enabled: false,
        agentVersion: '1.5.0',
        log: vi.fn(),
      }),
    ).toEqual([]);
  });

  it('refuses an old runtime and says why', () => {
    const dir = fakeExtensionDir();
    const log = vi.fn();

    expect(
      bridgeSpawnArgs({
        extensionDir: dir,
        enabled: true,
        agentVersion: '0.80.3',
        log,
      }),
    ).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('0.80.3');
  });

  it('refuses a bundle that is not on disk, and logs the path it looked for', () => {
    const dir = fakeExtensionDir(false);
    const log = vi.fn();

    expect(
      bridgeSpawnArgs({
        extensionDir: dir,
        enabled: true,
        agentVersion: '1.5.0',
        log,
      }),
    ).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain(bridgeExtensionPath(dir));
  });

  it('refuses an unknown extension dir without statting a relative path', () => {
    expect(
      bridgeSpawnArgs({
        extensionDir: '',
        enabled: true,
        agentVersion: '1.5.0',
      }),
    ).toEqual([]);
  });
});

describe('buildStartupArgs with the bridge', () => {
  it('passes exactly one -e, at a file that exists, ahead of the user arguments', () => {
    const dir = fakeExtensionDir();
    const bridgeArgs = bridgeSpawnArgs({
      extensionDir: dir,
      enabled: true,
      agentVersion: '1.4.0',
    });

    const args = buildStartupArgs(
      config({ extraArgs: ['--thinking', 'high'] }),
      undefined,
      bridgeArgs,
    );

    expect(args.filter((arg) => arg === '-e')).toHaveLength(1);
    const bundle = args[args.indexOf('-e') + 1];
    expect(bundle).toBe(bridgeExtensionPath(dir));
    expect(existsSync(bundle)).toBe(true);
    // `amulet.extraArgs` is the last word on how the child starts.
    expect(args.slice(-2)).toEqual(['--thinking', 'high']);
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf('--thinking'));
  });

  it('keeps the resume contract intact next to the bridge flag', () => {
    const dir = fakeExtensionDir();
    const args = buildStartupArgs(
      config({
        defaultModel: 'anthropic/claude-haiku-5',
        extraArgs: ['--foo'],
      }),
      '/home/u/.pi/agent/sessions/x/one.jsonl',
      bridgeSpawnArgs({
        extensionDir: dir,
        enabled: true,
        agentVersion: '1.5.0',
      }),
    );

    expect(args).toEqual([
      '--session',
      '/home/u/.pi/agent/sessions/x/one.jsonl',
      '-e',
      bridgeExtensionPath(dir),
      '--foo',
    ]);
  });

  it('still starts a plain session when the bridge is refused', () => {
    const args = buildStartupArgs(
      config(),
      undefined,
      bridgeSpawnArgs({
        extensionDir: fakeExtensionDir(false),
        enabled: true,
        agentVersion: '1.5.0',
      }),
    );

    expect(args).toEqual([]);
  });
});
