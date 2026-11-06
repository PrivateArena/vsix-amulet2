import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the bridge gets into the child process.
 *
 * Amulet ships the bridge as a bundle (`dist/pi-bridge/amulet-bridge.mjs`) and hands it to pi with
 * `-e`, which loads an extension from an explicit path: no write to `~/.pi/settings.json`, no
 * `pi install`, and consequently no row in the Packages dialog that a user could disable without
 * understanding what it turns off. It is also the reason the flag is *machine*-scoped like
 * `amulet.extraArgs` — it changes argv.
 */

/** Path of the bridge bundle, relative to the installed extension root (POSIX separators, split on use). */
export const BRIDGE_BUNDLE_REL_PATH = 'dist/pi-bridge/amulet-bridge.mjs';

/**
 * The oldest pi that has both halves the bridge needs: `context_edit` entries with the `context` hook,
 * and `ctx.navigateTree` in the command context. Verified against 1.4.0 and 1.5.0; 0.80.x is below the
 * floor and gets today's behaviour with no `-e` at all.
 */
export const MIN_PI_VERSION_FOR_BRIDGE = '1.4.0';

/** Absolute path of the bundle inside an installed extension directory. */
export function bridgeExtensionPath(extensionDir: string): string {
  return join(extensionDir, ...BRIDGE_BUNDLE_REL_PATH.split('/'));
}

/** Parse `1.4.0`, `v1.5.0-beta.1`, `1.4` — anything without a leading major.minor is unknown. */
function parseVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/**
 * Whether this pi can carry the bridge. An unreadable version string is treated as *unsupported*:
 * loading an extension into a runtime whose `context_edit` semantics we cannot confirm would corrupt
 * nothing, but it would let the UI offer an action that silently does not apply.
 */
export function supportsBridge(agentVersion: string): boolean {
  const found = parseVersion(agentVersion);
  const floor = parseVersion(MIN_PI_VERSION_FOR_BRIDGE);
  if (!found || !floor) return false;
  for (let i = 0; i < floor.length; i++) {
    if (found[i] > floor[i]) return true;
    if (found[i] < floor[i]) return false;
  }
  return true;
}

export interface BridgeSpawnOptions {
  /** The installed extension directory (`vscode.ExtensionContext.extensionUri.fsPath`). */
  extensionDir: string;
  /** `amulet.contextEditing`. */
  enabled: boolean;
  /** Cached `pi --version` of the binary this child is about to be. */
  agentVersion: string;
  /** Why a refused load happened, in the output channel. */
  log?: (message: string) => void;
}

/**
 * The argv fragment that loads the bridge, or `[]`.
 *
 * Three independent reasons for `[]`, each logged: the setting is off, the runtime is too old, or the
 * bundle is not on disk (a partially installed VSIX, or a build that never ran). Never a guess: a
 * missing `-e` costs a feature, a wrong one costs the child process at startup.
 */
export function bridgeSpawnArgs(options: BridgeSpawnOptions): string[] {
  const note = (message: string) => options.log?.(message);
  if (!options.enabled) return [];
  if (!supportsBridge(options.agentVersion)) {
    note(
      `Context editing needs pi ${MIN_PI_VERSION_FOR_BRIDGE} or newer (found ${
        options.agentVersion || 'unknown version'
      }); the bridge is not loaded.`,
    );
    return [];
  }
  const bundle = bridgeExtensionPath(options.extensionDir);
  if (!options.extensionDir || !existsSync(bundle)) {
    note(
      `Context editing is on but ${bundle} is missing; the bridge is not loaded.`,
    );
    return [];
  }
  return ['-e', bundle];
}
