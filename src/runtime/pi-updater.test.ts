import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PiConfig } from '../config';
import { PI_UPDATE_ARGS, updatePi } from './pi-updater';

// `src/config.ts` is only imported as a type, so this stays vscode-free.
const config = (binaryPath: string): PiConfig => ({
  binaryPath,
  agentDir: '',
  defaultModel: '',
  thinkingLevel: 'medium',
  autoCompact: true,
  autoRetry: true,
  extraArgs: [],
});

/** Absolute path to an executable stub standing in for the global `pi`. */
function fakePi(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pintra-updater-'));
  const file = join(dir, 'pi');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const unix = process.platform === 'win32' ? describe.skip : describe;

unix('updatePi', () => {
  it('runs `pi update --all --force` and collects its output', async () => {
    const lines: string[] = [];
    const result = await updatePi({
      config: config(fakePi('echo "args: $*"; echo updating')),
      cwd: process.cwd(),
      onOutput: (line) => lines.push(line),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(PI_UPDATE_ARGS.join(' '));
    expect(lines).toEqual(['args: update --all --force', 'updating']);
  });

  it('reports failure with the exit code and stderr', async () => {
    const result = await updatePi({
      config: config(fakePi('echo "registry unreachable" >&2; exit 3')),
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('registry unreachable');
  });

  it('kills the child when the signal aborts', async () => {
    const controller = new AbortController();
    let started = () => {};
    const isUp = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = updatePi({
      config: config(fakePi('echo started; exec sleep 30')),
      cwd: process.cwd(),
      signal: controller.signal,
      onOutput: (line) => {
        if (line === 'started') started();
      },
    });
    await isUp;
    controller.abort();

    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('started');
  });

  it('fails without spawning when the binary cannot be resolved', async () => {
    const result = await updatePi({
      config: config('/definitely/not/here/pi'),
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('not found');
  });
});
