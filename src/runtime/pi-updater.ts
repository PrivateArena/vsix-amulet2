import { spawn } from 'node:child_process';
import type { PiConfig } from '../config';
import { buildSpawnEnv, resolveBinaryPath } from './bootstrap';

/**
 * `pi update --all --force`: refresh pi and every installed package, reinstalling
 * even when the current version already looks latest (pi's own `--force` flag).
 */
export const PI_UPDATE_ARGS = ['update', '--all', '--force'];

export interface PiUpdateResult {
  /** Exit code 0 and not cancelled. */
  ok: boolean;
  /** Terminated through the abort signal before finishing. */
  cancelled: boolean;
  /** Child exit code, or null when it never ran / failed to spawn. */
  exitCode: number | null;
  /** Combined stdout + stderr, for the log channel and error detail. */
  output: string;
}

export interface PiUpdateOptions {
  config: PiConfig;
  /** Working directory for the update (the workspace root). */
  cwd: string;
  /** One call per complete output line, for progress reporting and logging. */
  onOutput?: (line: string) => void;
  /** Abort to terminate the child process (the progress "cancel" affordance). */
  signal?: AbortSignal;
}

/**
 * Run a one-shot `pi update` against the same binary the runtime spawns, so the
 * update lands on the pi install this workspace actually uses.
 */
export async function updatePi(
  options: PiUpdateOptions,
): Promise<PiUpdateResult> {
  const resolved = resolveBinaryPath(options.config.binaryPath || 'pi');
  if (!resolved.resolved) {
    return {
      ok: false,
      cancelled: false,
      exitCode: null,
      output: `pi binary "${options.config.binaryPath}" not found (searched: ${resolved.searchedDirs.slice(0, 8).join(', ')}…)`,
    };
  }

  return new Promise((resolve) => {
    const collected: string[] = [];
    let partial = '';

    // Split the stream into lines, forwarding each to `onOutput` and keeping a
    // copy for the final result. stdout and stderr share one buffer so ordering
    // matches what the user would see in a terminal.
    const consume = (text: string): void => {
      partial += text;
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        collected.push(line);
        options.onOutput?.(line);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      // SECURITY: argv array + shell:false — never interpolate the setting into
      // a shell string (mirrors rpc-process.ts / getAgentVersion).
      child = spawn(resolved.command, PI_UPDATE_ARGS, {
        cwd: options.cwd,
        env: { ...process.env, ...buildSpawnEnv(options.config) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      resolve({
        ok: false,
        cancelled: false,
        exitCode: null,
        output: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let cancelled = false;
    const onAbort = (): void => {
      if (cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      // Escalate in case the updater ignores SIGTERM; unref'd so it never keeps
      // the extension host alive.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    };
    options.signal?.addEventListener('abort', onAbort);

    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (partial) {
        collected.push(partial);
        options.onOutput?.(partial);
        partial = '';
      }
      resolve({
        ok: exitCode === 0 && !cancelled,
        cancelled,
        exitCode,
        output: collected.join('\n').trim(),
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => consume(chunk));
    child.stderr?.on('data', (chunk: string) => consume(chunk));
    child.on('error', (err: Error) => {
      collected.push(err.message);
      finish(null);
    });
    // 'close' waits for the stdio pipes to drain, which a lingering grandchild
    // can hold open; fall back to 'exit' so a cancelled update still resolves.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 250).unref?.();
    });
    child.on('close', (code) => finish(code));
  });
}
