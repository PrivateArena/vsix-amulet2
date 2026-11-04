/**
 * The operations behind the Packages dialog: list, install, remove, enable, disable.
 *
 * Two mechanisms, because the five operations are not alike:
 *
 *  - **list / enable / disable** touch only `settings.json`, so Amulet edits it directly
 *    (`package-settings.ts`) — instant, offline, reversible, and identical to what pi's own
 *    `pi config` TUI writes.
 *  - **install / remove** move bytes through npm or git and know things only pi knows (the managed
 *    npm project, git ref reconciliation, the identity rules that decide whether `npm:foo@1` and
 *    `npm:foo` are one package), so they run the real `pi` subcommand.
 *
 * Either way the running child process is unaffected: pi reads its settings at startup and there is
 * no RPC command to make it re-read them, so every mutation leaves `reloadRequired` set until the
 * runtimes restart.
 */

import type {
  PackageEntry,
  PackageListResult,
  PackageOpResult,
  PackageOperation,
  PackageScope,
} from '../../shared/protocol';
import { validatePackageSource } from '../../shared/pi-packages';
import type { PiConfig } from '../config';
import { resolveAgentDir } from '../runtime/bootstrap';
import { runPiCommand } from '../runtime/pi-cli';
import { PackageDirs, packageRows } from './package-catalog';
import {
  packagesFingerprint,
  readPackagesFile,
  resolveProjectTrust,
  settingsFileFor,
  setPackageEnabled,
  userSettingsFile,
  projectSettingsFile,
} from './package-settings';

export { userSettingsFile, projectSettingsFile };

export interface PackageListOptions {
  dirs: PackageDirs;
  /**
   * Fingerprint of the declarations the current runtime loaded when its child started, or null when
   * that is unknown (a runtime that never came up).
   */
  baseline: string | null;
  /** Echoed back so the caller can drop an answer that arrived after a newer request. */
  requestId: number;
}

export function listPackages(options: PackageListOptions): PackageListResult {
  const { dirs } = options;
  const userFile = readPackagesFile(userSettingsFile(dirs));
  const projectFile = readPackagesFile(projectSettingsFile(dirs));
  const trust = resolveProjectTrust(dirs);
  const packages = markShadowed([
    ...packageRows(userFile, 'user', dirs),
    ...packageRows(projectFile, 'project', dirs),
  ]);

  return {
    requestId: options.requestId,
    cwd: dirs.cwd,
    userSettingsFile: userFile.path,
    projectSettingsFile: projectFile.path,
    // pi reads the project file only when the folder is trusted; until then its declarations are
    // inert, and `pi install -l` refuses to write it.
    projectTrusted: trust.trusted,
    packages,
    reloadRequired:
      options.baseline !== null &&
      packagesFingerprint([userFile, projectFile]) !== options.baseline,
    errors: [userFile, projectFile].flatMap((file) =>
      file.error ? [`${file.path}: ${file.error}`] : [],
    ),
  };
}

/**
 * Mark the declarations pi will not act on.
 *
 * pi identifies a package by what the source means, not by how it is spelled, and resolves a clash
 * by precedence: a project declaration replaces a user one (unless it is an `autoload: false`
 * delta, which narrows it), and inside one file the first declaration wins. Listing both rows without
 * saying which one decides would let the human toggle a row that cannot change anything — so the
 * losing rows are marked, and the dialog disables them.
 */
export function markShadowed(packages: PackageEntry[]): PackageEntry[] {
  // pi's own resolution order: project entries first, then user, each in file order, first seen wins.
  const ordered = [
    ...packages.filter((entry) => entry.scope === 'project'),
    ...packages.filter((entry) => entry.scope === 'user'),
  ];
  const winners = new Map<string, PackageEntry>();
  for (const entry of ordered) {
    const winner = winners.get(entry.identity);
    if (!winner) {
      winners.set(entry.identity, entry);
      continue;
    }
    entry.shadowed =
      winner.scope === entry.scope
        ? 'An earlier declaration of this package in the same file is the one pi loads.'
        : winner.scope === 'project' && !winner.enabled
          ? 'The project declaration of this package narrows it, and decides what loads.'
          : 'The project declaration of this package replaces this one.';
  }
  return packages;
}

/** What the running pi loaded, so a later listing can say whether it still matches. */
export function packagesFingerprintOf(dirs: PackageDirs): string {
  return packagesFingerprint([
    readPackagesFile(userSettingsFile(dirs)),
    readPackagesFile(projectSettingsFile(dirs)),
  ]);
}

/**
 * Claim the right to run a package command for this agent directory, or null when somebody already
 * has. Keyed by the install roots the command writes (`<agentDir>/npm`, `<agentDir>/git`, the two
 * settings files), because that is what two concurrent `pi install` children would corrupt — and the
 * second claimant can be another chat surface, or another window on the same agent directory.
 */
export function beginPackageCommand(dirs: PackageDirs): (() => void) | null {
  const key = `${resolveAgentDir(dirs.agentDir, dirs.cwd)}\u0000${dirs.cwd}`;
  if (PACKAGE_COMMANDS.has(key)) return null;
  PACKAGE_COMMANDS.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    PACKAGE_COMMANDS.delete(key);
  };
}

const PACKAGE_COMMANDS = new Set<string>();

export interface PackageCommandOptions {
  config: PiConfig;
  dirs: PackageDirs;
  op: Extract<PackageOperation, 'install' | 'remove'>;
  source: string;
  scope: PackageScope;
  /** Id echoed back on the result, so the surface that asked recognises its own answer. */
  opId: number;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Run `pi install|remove <source>`, for the user or the project settings scope.
 *
 * The trust flag is always explicit. An untrusted folder must not end up with pi silently loading
 * and running its project extensions just because Amulet asked for a package — `-na` says "ignore
 * project-local files", which is also what keeps the command's output deterministic. A project-scope
 * write needs the opposite flag, and is refused here rather than by the dialog: `-a` grants trust for
 * the run, so a stale listing must not be able to write into a folder the human has not trusted.
 */
export async function runPackageCommand(
  options: PackageCommandOptions,
): Promise<PackageOpResult> {
  const { op, source, scope, opId } = options;
  const refused = (output: string): PackageOpResult => ({
    op,
    opId,
    source,
    ok: false,
    exitCode: null,
    output,
  });

  const invalid = validatePackageSource(source);
  if (invalid) return refused(invalid);

  if (scope === 'project') {
    if (!resolveProjectTrust(options.dirs).trusted) {
      return refused(
        `Pi only writes ${projectSettingsFile(options.dirs)} after this folder is trusted.`,
      );
    }
  }

  const args = [op, source.trim()];
  if (scope === 'project') args.push('-l', '-a');
  else args.push('-na');

  const result = await runPiCommand({
    config: options.config,
    cwd: options.dirs.cwd,
    args,
    onOutput: options.onOutput,
    signal: options.signal,
  });

  return {
    op,
    opId,
    source,
    ok: result.ok,
    cancelled: result.cancelled,
    exitCode: result.exitCode,
    // `pi install` prints progress and then the verdict. npm can answer a failure with a whole log,
    // and the dialog shows one line of it: keep the tail, which is where the reason is.
    output: tail(result.output, PACKAGE_OP_OUTPUT_LIMIT),
  };
}

/** What the dialog can render of a command's output; the log channel keeps the whole of it. */
const PACKAGE_OP_OUTPUT_LIMIT = 4000;

function tail(text: string | undefined, limit: number): string | undefined {
  if (!text || text.length <= limit) return text;
  return `…\n${text.slice(-limit)}`;
}

export interface PackageToggleOptions {
  dirs: PackageDirs;
  source: string;
  index: number;
  scope: PackageScope;
  enabled: boolean;
  opId: number;
}

/** Enable or disable one declaration by editing the settings file that holds it. */
export function togglePackage(options: PackageToggleOptions): PackageOpResult {
  const { scope, enabled, dirs, source, opId } = options;
  const op: PackageOperation = enabled ? 'enable' : 'disable';
  const file = settingsFileFor(scope, dirs);
  const fail = (output: string): PackageOpResult => ({
    op,
    opId,
    source,
    ok: false,
    exitCode: null,
    output,
  });

  // A project declaration pi will not read is not a thing worth switching off, and writing that file
  // behind an untrusted folder is not Amulet's to do.
  if (scope === 'project' && !resolveProjectTrust(dirs).trusted) {
    return fail(
      `Pi only reads ${file} after this folder is trusted. Trust it, or manage the package in the User scope.`,
    );
  }

  const written = setPackageEnabled(file, {
    source,
    index: options.index,
    enabled,
  });
  return written.ok
    ? { op, opId, source, ok: true, exitCode: 0 }
    : fail(written.error ?? `Could not update ${file}`);
}
