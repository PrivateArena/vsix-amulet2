/**
 * Reading and writing pi's package declarations.
 *
 * pi keeps its configuration in `settings.json` files — one per scope — and the `packages` array of
 * each is the list of installed pi packages. There is no RPC command for any of it (`rpc-commands.md`
 * lists 33 commands, none about settings), so the dialog reads these files itself and edits the one
 * entry it was asked about. Everything that has to move bytes on a registry — install and remove —
 * stays with the `pi` CLI (see `package-service.ts`), because only pi knows how to reconcile an npm
 * or git checkout.
 *
 * Two rules copied from pi's own writer (`SettingsManager.persistScopedSettings`), so a file Amulet
 * touched is still byte-compatible with one pi would have written: 2-space JSON with the file's other
 * keys kept in their existing order, and no trailing newline.
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageScope } from '../../shared/protocol';
import { resolveAgentDir } from '../runtime/bootstrap';

/** A `packages` element as declared: the string form, the object form, or junk from a bad edit. */
export type PackageDeclaration = unknown;

/** One settings file's `packages` array, plus why it might be empty when it should not be. */
export interface PackagesFile {
  path: string;
  /** The file exists; a missing file is an empty list, not a failure. */
  exists: boolean;
  entries: PackageDeclaration[];
  /** Content hash of {@link entries} only, so unrelated settings writes do not look like package changes. */
  fingerprint: string;
  /** Why the file contributed nothing: unreadable, not JSON, or `packages` is not an array. */
  error?: string;
}

export interface PackageWriteRequest {
  /** Declaration to edit, addressed by the row the human clicked. */
  source: string;
  index: number;
  enabled: boolean;
}

export interface PackageWriteResult {
  ok: boolean;
  /** False when the file already said what was asked, so nothing was written. */
  changed: boolean;
  error?: string;
}

/** Refuse to `JSON.parse` a settings file this big: it is a few KB of hand-edited JSON, and a
 * loop that grew it megabytes is a corruption we should report rather than load. */
const SETTINGS_READ_LIMIT_BYTES = 4 * 1024 * 1024;

const RESOURCE_FILTER_KEYS = [
  'extensions',
  'skills',
  'prompts',
  'themes',
] as const;

/**
 * What makes a project folder "trust-requiring" — copied from pi's own
 * `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`, because a folder with none of these is trusted without
 * asking and the dialog has to know that (see {@link resolveProjectTrust}).
 */
const TRUST_REQUIRING_PROJECT_FILES = [
  'settings.json',
  'mcp.json',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
];

export interface PackageScopeDirs {
  /** `amulet.agentDir`, empty for pi's own default. */
  agentDir: string;
  /** The runtime working directory, which is what "project scope" means. */
  cwd: string;
}

export function userSettingsFile(dirs: PackageScopeDirs): string {
  return join(resolveAgentDir(dirs.agentDir, dirs.cwd), 'settings.json');
}

export function projectSettingsFile(dirs: PackageScopeDirs): string {
  return join(dirs.cwd, '.pi', 'settings.json');
}

export function settingsFileFor(
  scope: PackageScope,
  dirs: PackageScopeDirs,
): string {
  return scope === 'project'
    ? projectSettingsFile(dirs)
    : userSettingsFile(dirs);
}

export interface ProjectTrustState {
  /** Whether pi will read this folder's `.pi/settings.json` at startup. */
  trusted: boolean;
  /** The decision stored in `trust.json`, or null when pi has never been asked. */
  decision: boolean | null;
}

/**
 * Pi's answer to "may this folder's settings be loaded", not merely what `trust.json` says.
 *
 * The difference matters at both ends. A folder with nothing trust-requiring needs no decision at all
 * — pi trusts it (`resolveProjectTrusted` falls back to `true` when there is nothing to trust), which
 * is exactly the case in which a first `pi install -l` creates `.pi/settings.json`. Reading only
 * `trust.json` would refuse that write forever: the file whose absence makes the folder trusted is the
 * file the dialog would then never be able to create.
 */
export function resolveProjectTrust(dirs: PackageScopeDirs): ProjectTrustState {
  const decision = readStoredTrust(dirs);
  if (decision !== null) return { trusted: decision, decision };
  if (!hasTrustRequiringProjectResources(dirs.cwd))
    return { trusted: true, decision };
  // `defaultProjectTrust: "always"` is the user's standing yes to the question pi would otherwise ask.
  return {
    trusted: readDefaultProjectTrust(dirs) === 'always',
    decision,
  };
}

/** The nearest stored decision for `cwd`, or null when pi has never asked. */
function readStoredTrust(dirs: PackageScopeDirs): boolean | null {
  const data = readJsonFile(
    join(resolveAgentDir(dirs.agentDir, dirs.cwd), 'trust.json'),
  );
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const entries = Object.entries(data as Record<string, unknown>);
  let current = canonicalize(dirs.cwd);
  for (;;) {
    for (const [key, value] of entries) {
      // pi keys the file by its own canonicalised path, so compare canonically too: a workspace
      // opened through a symlink must find the decision stored against the real directory.
      if (!pathsEqual(key, current)) continue;
      if (typeof value === 'boolean') return value;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readDefaultProjectTrust(dirs: PackageScopeDirs): string | undefined {
  const settings = readJsonFile(userSettingsFile(dirs));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return undefined;
  }
  const value = (settings as Record<string, unknown>).defaultProjectTrust;
  return typeof value === 'string' ? value : undefined;
}

export function hasTrustRequiringProjectResources(cwd: string): boolean {
  const configDir = join(canonicalize(cwd), '.pi');
  if (
    TRUST_REQUIRING_PROJECT_FILES.some((name) =>
      existsSync(join(configDir, name)),
    )
  ) {
    return true;
  }
  // pi also walks up looking for an `.agents/skills` directory.
  let current = canonicalize(cwd);
  for (;;) {
    if (existsSync(join(current, '.agents', 'skills'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** pi stores paths after resolving symlinks; fall back to the plain resolution when it fails. */
function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Case-insensitive on Windows, where pi stores trust keys as they were typed. */
function pathsEqual(a: string, b: string): boolean {
  const left = canonicalize(a);
  const right = canonicalize(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function readPackagesFile(file: string): PackagesFile {
  const empty = {
    path: file,
    entries: [] as PackageDeclaration[],
    fingerprint: '',
  };
  if (!existsSync(file)) return { ...empty, exists: false };

  let text: string;
  try {
    const size = statSync(file).size;
    if (size > SETTINGS_READ_LIMIT_BYTES) {
      return {
        ...empty,
        exists: true,
        error: `${file} is ${size} bytes, too large to read as a settings file`,
      };
    }
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ...empty, exists: true, error: describeError(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    return { ...empty, exists: true, error: describeError(err) };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...empty, exists: true, error: 'is not a JSON object' };
  }

  const packages = (parsed as Record<string, unknown>).packages;
  if (packages === undefined) return { ...empty, exists: true };
  if (!Array.isArray(packages)) {
    return { ...empty, exists: true, error: '"packages" is not an array' };
  }
  const entries = packages as PackageDeclaration[];
  return {
    path: file,
    exists: true,
    entries,
    fingerprint: stableKey(entries),
  };
}

/**
 * One fingerprint over several files' declarations: what the running pi loaded last time, against
 * what the files say now. Content alone — no paths, no mtime — because pi rewrites `settings.json`
 * for unrelated reasons (its own changelog marker, a thinking-level change) and that is not a
 * pending package change.
 */
export function packagesFingerprint(files: PackagesFile[]): string {
  return files.map((file) => file.fingerprint).join('\u0001');
}

/** The `source` of a declaration, or null when the element is not one pi can act on. */
export function sourceOf(entry: PackageDeclaration): string | null {
  if (typeof entry === 'string') return entry.trim() ? entry : null;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const source = (entry as Record<string, unknown>).source;
    if (typeof source === 'string' && source.trim()) return source;
  }
  return null;
}

/** pi's disable flag: absent means loaded, `false` means "only what the filters name". */
export function isAutoloadDisabled(entry: PackageDeclaration): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return (entry as Record<string, unknown>).autoload === false;
}

/** Whether the declaration names resources explicitly, so a toggle must keep them. */
export function hasResourceFilters(entry: PackageDeclaration): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return RESOURCE_FILTER_KEYS.some(
    (key) => record[key] !== undefined && record[key] !== null,
  );
}

/**
 * Flip one declaration in one settings file between loaded and autoload-disabled, in place.
 *
 * Mirrors what pi's own `pi config` TUI writes: disable is `{ source, autoload: false }` (filters
 * kept, because dropping them would silently widen the package back to all of its resources), and
 * enable is the plain string again once nothing but `autoload` is left — the object form without
 * `autoload` would still read as an intentional filter.
 *
 * The element is addressed by index because a file may declare one package twice with two different
 * source strings, and only the row that was clicked is the one to change. {@link
 * PackageWriteRequest.source} is then re-checked against what sits at that index, so a listing that
 * went stale cannot make the write land on somebody else's declaration — the file is refused instead.
 */
export function setPackageEnabled(
  file: string,
  request: PackageWriteRequest,
): PackageWriteResult {
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        changed: false,
        error: `${file} is not a JSON object`,
      };
    }
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, changed: false, error: describeError(err) };
  }

  const packages = settings.packages;
  if (!Array.isArray(packages)) {
    return {
      ok: false,
      changed: false,
      error: `${file} has no "packages" array to edit`,
    };
  }

  const current = packages[request.index];
  if (sourceOf(current) !== request.source) {
    return {
      ok: false,
      changed: false,
      error: `${file} changed since it was listed — re-read it before editing "${request.source}"`,
    };
  }
  if (isAutoloadDisabled(current) === !request.enabled) {
    return { ok: true, changed: false };
  }

  const next = request.enabled
    ? enableDeclaration(current, request.source)
    : disableDeclaration(current, request.source);
  const written = [...packages];
  written[request.index] = next;
  settings.packages = written;

  try {
    writeSettingsAtomic(file, JSON.stringify(settings, null, 2));
  } catch (err) {
    return { ok: false, changed: false, error: describeError(err) };
  }
  return { ok: true, changed: true };
}

/**
 * Write through a temporary file and rename it over the target.
 *
 * pi writes this same file under a `proper-lockfile` lock that Amulet does not hold, so a concurrent
 * write is possible (pi persisting a setting from a terminal, a second window on the same agent
 * directory). What must never happen is pi reading a half-written settings file, which is what a plain
 * `writeFileSync` of a large object can leave behind if the host dies mid-write; a rename is atomic
 * within a directory, so pi sees either the old file or the new one.
 */
function writeSettingsAtomic(file: string, text: string): void {
  const temp = `${file}.amulet-tmp`;
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, file);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp file is not the problem we are reporting */
    }
    throw err;
  }
}

function disableDeclaration(
  current: PackageDeclaration,
  source: string,
): Record<string, unknown> {
  if (typeof current === 'string') return { source, autoload: false };
  return { ...(current as object), source, autoload: false } as Record<
    string,
    unknown
  >;
}

function enableDeclaration(
  current: PackageDeclaration,
  source: string,
): string | Record<string, unknown> {
  if (typeof current === 'string') return source;
  const rest = { ...(current as object), source } as Record<string, unknown>;
  delete rest.autoload;
  // Collapse to the string form only when `autoload` was the single difference from it. Anything else
  // the file holds — a filter, or a field this version of Amulet does not know — is kept verbatim.
  const extra = Object.keys(rest).filter((key) => key !== 'source');
  return extra.length === 0 ? source : rest;
}

function readJsonFile(file: string): unknown {
  try {
    if (!existsSync(file)) return null;
    if (statSync(file).size > SETTINGS_READ_LIMIT_BYTES) return null;
    return JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Deterministic key order, so a re-serialised file with the same content fingerprints the same. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
    .join(',')}}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
