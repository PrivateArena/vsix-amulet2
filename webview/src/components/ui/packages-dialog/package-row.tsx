import { LuFolderOpen, LuLoader, LuTrash2 } from 'react-icons/lu';
import type { PackageEntry } from '../../../../../shared/protocol';
import { IconButton } from '../button';
import { initialsOf, kindsOf, toneOf } from './packages-view';

export interface PackageRowProps {
  entry: PackageEntry;
  /** An operation on this very declaration is in flight. */
  busy: boolean;
  /** pi reads project-scope declarations only after the folder is trusted. */
  projectTrusted: boolean;
  /** Non-null while the row is asking for a yes/no about deleting this declaration. */
  confirming: boolean;
  onToggle: (entry: PackageEntry, enabled: boolean) => void;
  onAskRemove: (entry: PackageEntry) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (entry: PackageEntry) => void;
}

/**
 * One `packages` declaration: what it is, what it adds, and the three things that can be done to it
 * — load it or not, delete it.
 *
 * The switch is enable/disable, which is pi's own `autoload` flag rather than an Amulet concept: the
 * declaration and its files stay on disk, so switching back on costs nothing. Remove is a different
 * animal (it runs `pi remove`, which uninstalls the checkout), so it asks first, inline — a shared
 * modal would sit under this overlay and the answer would be ambiguous about which row it was for.
 */
export function PackageRow({
  entry,
  busy,
  projectTrusted,
  confirming,
  onToggle,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: PackageRowProps) {
  const kinds = kindsOf(entry);
  const local = entry.kind === 'local';
  // Two reasons a row cannot be acted on: pi will not read this file at all (untrusted project), or it
  // will read the file and ignore this declaration (another one took precedence).
  const untrusted = entry.scope === 'project' && !projectTrusted;
  const shadowed = !!entry.shadowed;
  const inert = untrusted || shadowed;
  const disabled = busy || inert;

  return (
    <li className={`pk-row${entry.enabled ? '' : ' is-off'}`}>
      <span className={`pk-avatar pk-tone-${toneOf(entry.name)}`}>
        {local ? <LuFolderOpen aria-hidden /> : initialsOf(entry.name)}
      </span>

      <span className="pk-main">
        <span className="pk-name">
          {entry.name}
          {entry.version && (
            <span className="pk-version">v{entry.version}</span>
          )}
          {entry.scope === 'project' && (
            <span className="pk-badge">project</span>
          )}
          {entry.filtered && <span className="pk-badge">filtered</span>}
          {busy && <LuLoader className="pk-spin" aria-label="Working" />}
        </span>

        <span className="pk-summary">
          {entry.description || (
            <span className="pk-source" title={entry.source}>
              {entry.source}
            </span>
          )}
        </span>

        {(entry.error || entry.shadowed || untrusted || kinds.length > 0) && (
          <span className="pk-meta">
            {untrusted && (
              <span className="pk-warn">
                Pi ignores this until the folder is trusted.
              </span>
            )}
            {entry.shadowed && (
              <span className="pk-warn">{entry.shadowed}</span>
            )}
            {!untrusted && !shadowed && entry.error && (
              <span className="pk-warn">{entry.error}</span>
            )}
            {kinds.length > 0 && (
              <span className="pk-kinds">{kinds.join(' · ')}</span>
            )}
            {entry.author && <span className="pk-author">{entry.author}</span>}
          </span>
        )}
      </span>

      <span className="pk-actions">
        {confirming ? (
          <span className="pk-confirm">
            <span>Remove files and declaration?</span>
            <button
              type="button"
              className="pk-link danger"
              onClick={() => onConfirmRemove(entry)}>
              Remove
            </button>
            <button type="button" className="pk-link" onClick={onCancelRemove}>
              Cancel
            </button>
          </span>
        ) : (
          <>
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuTrash2}
              label={`Remove ${entry.name}`}
              tooltip={
                shadowed
                  ? 'Another declaration of this package is the one pi loads'
                  : local
                    ? 'Remove this declaration (leaves the folder on disk)'
                    : `Uninstall ${entry.name} and remove its declaration`
              }
              tooltipSide="top"
              disabled={disabled}
              onClick={() => onAskRemove(entry)}
            />
            <button
              type="button"
              role="switch"
              aria-checked={entry.enabled}
              aria-label={`${entry.enabled ? 'Disable' : 'Enable'} ${entry.name}`}
              title={
                shadowed
                  ? entry.shadowed
                  : untrusted
                    ? 'Trust the folder to change this'
                    : entry.enabled
                      ? 'Loaded by pi — click to disable'
                      : 'Disabled — click to enable'
              }
              className="pk-switch"
              disabled={disabled}
              onClick={() => onToggle(entry, !entry.enabled)}
            />
          </>
        )}
      </span>
    </li>
  );
}
