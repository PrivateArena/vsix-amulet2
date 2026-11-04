/**
 * Turning pi's package declarations into rows a human can read.
 *
 * A declaration is a source string; a row is that string plus everything the dialog shows: what it
 * points at on disk, whether the bytes are actually there, and what the package offers. All of it
 * is derived the way pi derives it (`DefaultPackageManager.getInstalledPath`), so a row that looks
 * installed here is one pi will load — and one it will warn about skipping when it is not.
 *
 * Nothing here imports `vscode`: the whole mapping is file reads, which keeps it testable.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  PackageEntry,
  PackageResourceKind,
  PackageScope,
  PackageSourceKind,
} from '../../shared/protocol';
import { resolveAgentDir } from '../runtime/bootstrap';
import {
  PackagesFile,
  hasResourceFilters,
  isAutoloadDisabled,
  sourceOf,
} from './package-settings';

export interface PackageDirs {
  /** `amulet.agentDir` — empty for pi's own default. */
  agentDir: string;
  /** The runtime working directory, which is what project scope means. */
  cwd: string;
}

export interface ParsedSource {
  kind: PackageSourceKind;
  /** Short display name: npm package name, git repository, or local directory. */
  name: string;
  /** Where pi loads the package from, when the source names a place. */
  installedPath?: string;
  /**
   * pi's package identity (`getPackageIdentity`): npm by package name, git by host/path without the
   * ref, local by resolved path. Two declarations with one identity are one package to pi, which is
   * what decides precedence between them.
   */
  identity: string;
}

const RESOURCE_KINDS: PackageResourceKind[] = [
  'extensions',
  'skills',
  'prompts',
  'themes',
];

/** Package metadata and resource discovery are small JSON/directory reads; a symlink loop or a huge
 * package tree must not cost the extension host thread. This runs on that thread, so the budget is one
 * small directory walk per resource type and nothing more. */
const MANIFEST_READ_LIMIT_BYTES = 1024 * 1024;
const RESOURCE_SCAN_MAX_DEPTH = 2;
const RESOURCE_SCAN_MAX_ENTRIES = 60;
const RESOURCE_SCAN_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
]);

/** pi's own resource file patterns (`core/package-manager.js` `FILE_PATTERNS`). */
const RESOURCE_EXTENSIONS: Record<PackageResourceKind, string[]> = {
  extensions: ['.ts', '.js'],
  skills: ['.md'],
  prompts: ['.md'],
  themes: ['.json'],
};

/** Conventional package layout: `<root>/extensions`, `<root>/skills`, … */
const RESOURCE_DIR_NAMES: Record<PackageResourceKind, string> = {
  extensions: 'extensions',
  skills: 'skills',
  prompts: 'prompts',
  themes: 'themes',
};

/**
 * Classify a source string and resolve where pi would keep it, following pi's own order
 * (`parseSource`): an `npm:` prefix wins, then a local path, then a git URL, with anything left over
 * treated as a local path — which is what makes a typo show up as a missing directory instead of
 * vanishing from the list.
 */
export function parsePackageSource(
  source: string,
  settingsFile: string,
  dirs: PackageDirs,
  scope: PackageScope,
): ParsedSource {
  const trimmed = source.trim();
  const roots = installRoots(scope, dirs);

  if (trimmed.startsWith('npm:')) {
    const name = npmPackageName(trimmed.slice('npm:'.length));
    return {
      kind: 'npm',
      name: name || trimmed,
      identity: `npm:${name || trimmed}`,
      installedPath: name ? join(roots.npm, name) : undefined,
    };
  }

  const git = parseGitSource(trimmed);
  if (git) {
    const relative = git.path ? join(git.host, git.path) : git.host;
    return {
      kind: 'git',
      name: git.repository || trimmed,
      identity: `git:${relative}`,
      installedPath: join(roots.git, relative),
    };
  }

  const path = resolveLocalPath(trimmed, settingsFile);
  return {
    kind: 'local',
    name: basename(path) || trimmed,
    identity: `local:${comparisonKey(path)}`,
    installedPath: path,
  };
}

/** Rows for every declaration of one scope, in the order the settings file lists them. */
export function packageRows(
  file: PackagesFile,
  scope: PackageScope,
  dirs: PackageDirs,
): PackageEntry[] {
  const rows: PackageEntry[] = [];
  let position = 0;
  for (const declaration of file.entries) {
    position += 1;
    const source = sourceOf(declaration);
    if (source === null) {
      // A declaration pi cannot even name still gets a row: silently dropping it would hide the
      // reason a package seems to be missing from the settings file.
      rows.push({
        source: `${scope} settings entry #${position}`,
        scope,
        index: position - 1,
        kind: 'local',
        name: '(unrecognised entry)',
        identity: `unknown:${file.path}:${position}`,
        enabled: false,
        filtered: false,
        hasFilters: false,
        installed: false,
        error: 'Not a package source: expected a string or { source, … }',
      });
      continue;
    }

    const parsed = parsePackageSource(source, file.path, dirs, scope);
    const location = parsed.installedPath;
    const present = !!location && existsSync(location);
    const manifest = location && present ? readManifest(location) : undefined;

    rows.push({
      source,
      scope,
      index: position - 1,
      kind: parsed.kind,
      name: parsed.name,
      identity: parsed.identity,
      enabled: !isAutoloadDisabled(declaration),
      // pi marks any object-form declaration as `(filtered)` in `pi list`.
      filtered: typeof declaration === 'object' && declaration !== null,
      hasFilters: hasResourceFilters(declaration),
      installedPath: location,
      installed: present,
      version: manifest?.version,
      description: manifest?.description,
      author: manifest?.author,
      resourceKinds: present ? manifest?.kinds : undefined,
      error: present
        ? undefined
        : 'Not installed — pi will try to fetch it at startup',
    });
  }
  return rows;
}

interface Manifest {
  version?: string;
  description?: string;
  author?: string;
  kinds?: PackageResourceKind[];
}

/**
 * One package's `package.json` plus what it offers.
 *
 * pi reads the `pi` manifest for explicit resource lists and falls back to the conventional
 * directories (`docs/packages.md`); this reports which of those exist, not how many files each
 * resolves to — an exact count would have to re-implement pi's globbing for a number the dialog
 * does not need.
 */
function readManifest(root: string): Manifest | undefined {
  const file = join(root, 'package.json');
  let manifest: Record<string, unknown> | undefined;
  try {
    if (statSync(file).size <= MANIFEST_READ_LIMIT_BYTES) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        manifest = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // No readable manifest: a git checkout without one, or a broken file. Discovery continues.
  }

  return {
    version:
      typeof manifest?.version === 'string' ? manifest.version : undefined,
    description:
      typeof manifest?.description === 'string'
        ? manifest.description.trim()
        : undefined,
    author: readAuthor(manifest?.author),
    kinds: discoverKinds(root, manifest),
  };
}

function readAuthor(author: unknown): string | undefined {
  if (typeof author === 'string') return author.trim() || undefined;
  if (author && typeof author === 'object' && !Array.isArray(author)) {
    const name = (author as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

function discoverKinds(
  root: string,
  manifest: Record<string, unknown> | undefined,
): PackageResourceKind[] {
  const declared = manifest?.pi;
  const fromManifest =
    declared && typeof declared === 'object' && !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : undefined;

  return RESOURCE_KINDS.filter((kind) => {
    const patterns = fromManifest?.[kind];
    if (Array.isArray(patterns)) return patterns.length > 0;
    return hasResourceFiles(join(root, RESOURCE_DIR_NAMES[kind]), kind);
  });
}

function hasResourceFiles(dir: string, kind: PackageResourceKind): boolean {
  let budget = RESOURCE_SCAN_MAX_ENTRIES;
  const extensions = RESOURCE_EXTENSIONS[kind];
  const walk = (current: string, depth: number): boolean => {
    if (depth > RESOURCE_SCAN_MAX_DEPTH || budget-- <= 0) return false;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return false;
      if (entry.isDirectory() && RESOURCE_SCAN_SKIP.has(entry.name)) continue;
      if (
        entry.isFile() &&
        extensions.some((ext) => entry.name.endsWith(ext))
      ) {
        return true;
      }
      // A skill is a directory holding SKILL.md; a bare .md inside `skills/` also counts.
      if (entry.isDirectory() && walk(join(current, entry.name), depth + 1)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}

function installRoots(
  scope: PackageScope,
  dirs: PackageDirs,
): { npm: string; git: string } {
  const base =
    scope === 'project'
      ? join(resolve(dirs.cwd), '.pi')
      : resolveAgentDir(dirs.agentDir);
  return { npm: join(base, 'npm', 'node_modules'), git: join(base, 'git') };
}

/**
 * The package name behind an npm spec, with the version range cut off: pi keeps `npm:@scope/name@1.2.3`
 * under `node_modules/@scope/name`, and treats a spec without a `/` and without a leading `@` as
 * `name` + `@version`.
 */
export function npmPackageName(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('@')) {
    const slash = trimmed.indexOf('/');
    if (slash === -1) return trimmed;
    const at = trimmed.indexOf('@', slash);
    return at === -1 ? trimmed : trimmed.slice(0, at);
  }
  const at = trimmed.indexOf('@');
  return at <= 0 ? trimmed : trimmed.slice(0, at);
}

/**
 * `host` + `owner/repository` for any of pi's accepted git shapes: `git:github.com/o/r@ref`,
 * `git:git@github.com:o/r`, `https://github.com/o/r`, `ssh://git@github.com/o/r`.
 *
 * Returns null for anything that is not one, so the caller can fall back to pi's own rule of
 * treating the source as a path. Version refs and a `.git` suffix are dropped because pi stores the
 * checkout without them.
 */
export function parseGitSource(
  source: string,
): { host: string; path?: string; repository: string } | null {
  let value = source.trim();
  const isGit =
    value.startsWith('git:') || /^(https?|ssh|git):\/\//i.test(value);
  if (!isGit) return null;
  if (value.startsWith('git:')) value = value.slice('git:'.length).trim();
  value = value.replace(/^(https?|ssh|git):\/\//i, '');

  // `git@github.com:owner/repo` (SCP syntax): the userinfo belongs to the host, so it is cut before
  // anything else looks for a separator.
  const head = value.includes('/') ? value.slice(0, value.indexOf('/')) : value;
  const userinfo = head.indexOf('@');
  if (userinfo >= 0) value = value.slice(userinfo + 1);

  // A `:` ahead of the first `/` is the SCP separator git itself accepts; rewrite it to a path.
  const colon = value.indexOf(':');
  const slash = value.indexOf('/');
  if (colon > 0 && (slash === -1 || colon < slash)) {
    value = `${value.slice(0, colon)}/${value.slice(colon + 1)}`;
  }

  const firstSlash = value.indexOf('/');
  if (firstSlash === -1) return null;
  const host = value.slice(0, firstSlash);
  let path = value.slice(firstSlash + 1);
  const at = path.lastIndexOf('@');
  if (at > 0) path = path.slice(0, at);
  path = path.split('#')[0].replace(/\/+$/, '');
  path = path.replace(/\.git$/, '');
  if (!host || !path) return null;
  return {
    host,
    path,
    repository: path.split('/').filter(Boolean).pop() ?? host,
  };
}

/** pi's own case-insensitive path comparison key (`getPathComparisonKey`). */
function comparisonKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function resolveLocalPath(source: string, settingsFile: string): string {
  const expanded = source.startsWith('~')
    ? join(homedir(), source.slice(source.indexOf('/') + 1))
    : source;
  return isAbsolute(expanded)
    ? resolve(expanded)
    : // pi resolves a relative local declaration from the directory its settings file lives in
      // (`docs/packages.md`), not from the process working directory.
      resolve(dirname(settingsFile), expanded);
}
