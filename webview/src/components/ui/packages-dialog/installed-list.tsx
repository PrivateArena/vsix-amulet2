import { useMemo, useState } from 'react';
import { LuSearch } from 'react-icons/lu';
import type {
  PackageEntry,
  PackageListResult,
} from '../../../../../shared/protocol';
import { usePackagesStore } from '../../../stores/packages-store';
import { PackageRow } from './package-row';
import {
  KIND_FILTERS,
  type PackageFilter,
  emptyStateText,
  filterPackages,
  kindCounts,
} from './packages-view';

/** Identifies a row by the file it came from and its position there — see `PackageEntry.index`. */
const rowKey = (entry: PackageEntry): string =>
  `${entry.scope}\u0000${entry.index}`;

/**
 * The Installed tab: every `packages` declaration of both scopes, with the controls that change them.
 *
 * Both scopes are listed together because a declaration is one line in one of two files, and the
 * question the dialog answers ("is this package loaded?") has an answer that comes from either. A
 * project row is marked, and inert while the folder is untrusted — writing that file behind pi's back
 * is not something Amulet does.
 */
export function InstalledList({
  result,
}: {
  result: PackageListResult | null;
}) {
  const busy = usePackagesStore((s) => s.busy);
  const setEnabled = usePackagesStore((s) => s.setEnabled);
  const remove = usePackagesStore((s) => s.remove);
  const [filter, setFilter] = useState<PackageFilter>({
    text: '',
    kind: 'all',
  });
  const [removing, setRemoving] = useState<string | null>(null);

  const entries = result?.packages ?? [];
  const counts = useMemo(() => kindCounts(entries), [entries]);
  const rows = useMemo(
    () => filterPackages(entries, filter),
    [entries, filter],
  );

  const isBusy = (entry: PackageEntry): boolean =>
    !!busy &&
    busy.op !== 'reload' &&
    busy.scope === entry.scope &&
    busy.index === entry.index;

  return (
    <div className="pk-installed">
      <label className="pk-filter">
        <LuSearch aria-hidden />
        <input
          type="search"
          value={filter.text}
          placeholder="Filter installed"
          aria-label="Filter installed packages"
          onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))}
        />
      </label>

      <div
        className="pk-chips"
        role="group"
        aria-label="Filter by resource type">
        {KIND_FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={filter.kind === chip.id}
            className={`pk-chip${filter.kind === chip.id ? ' is-active' : ''}`}
            onClick={() => setFilter((f) => ({ ...f, kind: chip.id }))}>
            {chip.label}
            <span className="pk-chip-count">{counts[chip.id]}</span>
          </button>
        ))}
      </div>

      {entries.length > 0 && (
        <p className="pk-count">
          Showing {rows.length} of {entries.length}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="pk-empty">{emptyStateText(result, filter)}</p>
      ) : (
        <ul className="pk-rows">
          {rows.map((entry) => (
            <PackageRow
              key={rowKey(entry)}
              entry={entry}
              busy={isBusy(entry)}
              projectTrusted={result?.projectTrusted ?? false}
              confirming={removing === rowKey(entry)}
              onToggle={(target, enabled) =>
                setEnabled(target.source, target.index, target.scope, enabled)
              }
              onAskRemove={(target) => setRemoving(rowKey(target))}
              onCancelRemove={() => setRemoving(null)}
              onConfirmRemove={(target) => {
                setRemoving(null);
                remove(target.source, target.index, target.scope);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
