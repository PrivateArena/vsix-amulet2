/**
 * Pure view rules for the Packages dialog.
 *
 * The rows arrive already described by the host (`src/packages/package-catalog.ts`); what is left is
 * presentation logic that must not depend on rendering: which rows the current filter keeps, how many
 * each kind chip stands for, and how a source string becomes a short label and an avatar.
 */

import type {
  PackageEntry,
  PackageListResult,
  PackageOpResult,
  PackageResourceKind,
} from '../../../../../shared/protocol';

export type PackageKindFilter = 'all' | PackageResourceKind;

/** Order of the filter chips, mirroring pi's own `RESOURCE_TYPES`. */
export const KIND_FILTERS: Array<{ id: PackageKindFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'skills', label: 'Skills' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'themes', label: 'Themes' },
];

export interface PackageFilter {
  text: string;
  kind: PackageKindFilter;
}

/** Kinds pi can load from a row, empty for a package that offers nothing (or is not on disk). */
export function kindsOf(entry: PackageEntry): PackageResourceKind[] {
  return entry.resourceKinds ?? [];
}

function matchesText(entry: PackageEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    entry.name,
    entry.source,
    entry.description ?? '',
    entry.author ?? '',
    entry.version ?? '',
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

/** Rows the filter keeps, in the order the settings files declare them. */
export function filterPackages(
  packages: PackageEntry[],
  filter: PackageFilter,
): PackageEntry[] {
  const needle = filter.text.trim().toLowerCase();
  return packages.filter((entry) => {
    if (filter.kind !== 'all' && !kindsOf(entry).includes(filter.kind))
      return false;
    return matchesText(entry, needle);
  });
}

/** How many rows each chip would show, counted on the unfiltered list. */
export function kindCounts(
  packages: PackageEntry[],
): Record<PackageKindFilter, number> {
  const counts = { all: packages.length } as Record<PackageKindFilter, number>;
  for (const kind of KIND_FILTERS) {
    if (kind.id === 'all') continue;
    counts[kind.id] = packages.filter((entry) =>
      kindsOf(entry).includes(kind.id as PackageResourceKind),
    ).length;
  }
  return counts;
}

/** Two letters of the package name, the way the gallery tiles its packages. */
export function initialsOf(name: string): string {
  const clean = name.replace(/^[^A-Za-z0-9]+/, '');
  return (clean.slice(0, 2) || '??').toUpperCase();
}

/**
 * A stable colour bucket per name, so one package keeps its tile colour across lists.
 * The count matches the `pk-tone-*` rules in `packages-dialog.scss`.
 */
export const AVATAR_TONES = 6;

export function toneOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % AVATAR_TONES;
}

/** Human text for an operation in flight or just finished. */
export function operationLabel(result: PackageOpResult): string {
  switch (result.op) {
    case 'install':
      return `Installing ${result.source}`;
    case 'remove':
      return `Removing ${result.source}`;
    case 'enable':
      return `Enabled ${result.source}`;
    case 'disable':
      return `Disabled ${result.source}`;
    case 'reload':
      return 'Reloading pi';
  }
}

/** The alert line after an operation, or null when nothing needs saying. */
export function operationAlert(
  result: PackageOpResult | null,
): { level: 'ok' | 'error'; text: string } | null {
  if (!result) return null;
  if (result.cancelled) {
    return { level: 'error', text: `${operationLabel(result)} cancelled.` };
  }
  if (result.ok) {
    if (result.op === 'reload') return { level: 'ok', text: 'Pi reloaded.' };
    if (result.op === 'install') {
      return { level: 'ok', text: `Installed ${result.source}.` };
    }
    if (result.op === 'remove') {
      return { level: 'ok', text: `Removed ${result.source}.` };
    }
    return null;
  }
  const detail = result.output ? ` — ${lastMeaningfulLine(result.output)}` : '';
  return { level: 'error', text: `${operationLabel(result)} failed${detail}.` };
}

/**
 * The line worth showing from a command that failed.
 *
 * `pi install` prints progress lines and then an `Error: …` verdict, and npm puts the actionable
 * sentence last; a whole registry log does not fit in an alert.
 */
function lastMeaningfulLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((line) => /^error:/i.test(line));
  return (error ?? lines[lines.length - 1] ?? output).replace(/[.\s]+$/, '');
}

/** Empty-state copy, which depends on whether anything is configured at all. */
export function emptyStateText(
  result: PackageListResult | null,
  filter: PackageFilter,
): string {
  if (!result) return 'Reading the pi settings files…';
  if (!result.packages.length) {
    return 'No pi packages installed yet. Install one to add extensions, skills, prompts or themes.';
  }
  if (filter.text.trim() || filter.kind !== 'all') {
    return 'No package matches this filter.';
  }
  return 'Nothing to show.';
}
