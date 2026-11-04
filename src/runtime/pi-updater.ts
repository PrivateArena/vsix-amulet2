import {
  runPiCommand,
  type PiCommandOptions,
  type PiCommandResult,
} from './pi-cli';

/**
 * `pi update --all --force`: refresh pi and every installed package, reinstalling
 * even when the current version already looks latest (pi's own `--force` flag).
 */
export const PI_UPDATE_ARGS = ['update', '--all', '--force'];

export type PiUpdateOptions = Omit<PiCommandOptions, 'args'>;

export type PiUpdateResult = PiCommandResult;

/**
 * Run a one-shot `pi update` against the same binary the runtime spawns, so the
 * update lands on the pi install this workspace actually uses.
 */
export async function updatePi(
  options: PiUpdateOptions,
): Promise<PiUpdateResult> {
  return runPiCommand({ ...options, args: PI_UPDATE_ARGS });
}
