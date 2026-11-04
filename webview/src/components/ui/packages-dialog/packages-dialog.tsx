import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuInfo, LuPlus, LuRefreshCw, LuX } from 'react-icons/lu';
import { useChatState } from '../../../contexts/chat-context';
import { useEscapeKey } from '../../../hooks/use-escape-key';
import { usePackagesStore } from '../../../stores/packages-store';
import { Button, IconButton } from '../button';
import { DiscoverPanel } from './discover-panel';
import { InstalledList } from './installed-list';
import { InstallForm } from './install-form';
import { operationAlert } from './packages-view';
import './packages-dialog.scss';

/**
 * The package manager, as a floating dialog rather than a screen of its own.
 *
 * Everything the dialog can do is a change to files on disk plus a runtime restart, so it is a
 * detour from the conversation and not a new destination: it opens over the chat, like "Show session
 * info", and closing it leaves the transcript exactly where it was.
 *
 * Nothing here is privileged: the declarations, the toggles and the `pi install` child all live on the
 * host (`src/packages/`), because the webview has no filesystem and must not gain one.
 */
export function PackagesDialog() {
  const open = usePackagesStore((s) => s.open);
  const close = usePackagesStore((s) => s.close);
  const tab = usePackagesStore((s) => s.tab);
  const setTab = usePackagesStore((s) => s.setTab);
  const installOpen = usePackagesStore((s) => s.installOpen);
  const setInstallOpen = usePackagesStore((s) => s.setInstallOpen);
  const list = usePackagesStore((s) => s.list);
  const busy = usePackagesStore((s) => s.busy);
  const lastOp = usePackagesStore((s) => s.lastOp);
  const refresh = usePackagesStore((s) => s.refresh);
  const reload = usePackagesStore((s) => s.reload);
  const cancel = usePackagesStore((s) => s.cancel);
  const { status, streaming } = useChatState();
  const dialogRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEscapeKey(close, open);

  // Initial tab stop inside the dialog, focus back where it came from on close — the same contract
  // every other overlay in this webview keeps.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  const alert = operationAlert(lastOp);
  const cliOp = busy?.op === 'install' || busy?.op === 'remove';
  const installing = !!cliOp;
  const ready = status.phase === 'ready';

  return createPortal(
    <div
      className="pk-overlay"
      onMouseDown={(e) => {
        // Not a click: dragging a selection out of a source string must not close us.
        if (e.target === e.currentTarget) close();
      }}>
      <div
        className="pk-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Pi Packages">
        <div className="pk-head">
          <span className="pk-title">Pi Packages</span>
          <span className="pk-head-actions">
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuRefreshCw}
              label="Re-read the settings files"
              tooltipSide="bottom"
              disabled={!!busy}
              onClick={refresh}
            />
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuPlus}
              label="Install a package"
              tooltip={
                tab === 'installed'
                  ? 'Install a package from a source'
                  : 'Available on the Installed tab'
              }
              tooltipSide="bottom"
              disabled={tab !== 'installed' || !!busy}
              onClick={() => setInstallOpen(!installOpen)}
            />
            <IconButton
              variant="ghost"
              size="sm"
              icon={LuX}
              label="Close"
              tooltipSide="bottom"
              onClick={close}
            />
          </span>
        </div>

        <div className="pk-tabs" role="tablist" aria-label="Packages">
          <button
            type="button"
            role="tab"
            id={`${panelId}-tab-installed`}
            aria-selected={tab === 'installed'}
            aria-controls={`${panelId}-panel`}
            className={`pk-tab${tab === 'installed' ? ' is-active' : ''}`}
            onClick={() => setTab('installed')}>
            Installed
            {list && (
              <span className="pk-tab-count">{list.packages.length}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            id={`${panelId}-tab-discover`}
            aria-selected={tab === 'discover'}
            aria-controls={`${panelId}-panel`}
            className={`pk-tab${tab === 'discover' ? ' is-active' : ''}`}
            onClick={() => setTab('discover')}>
            Discover
          </button>
        </div>

        <div
          className="pk-body"
          role="tabpanel"
          id={`${panelId}-panel`}
          aria-labelledby={
            tab === 'installed'
              ? `${panelId}-tab-installed`
              : `${panelId}-tab-discover`
          }>
          {tab === 'installed' && installOpen && list && (
            <InstallForm
              cwd={list.cwd}
              projectTrusted={list.projectTrusted}
              busy={installing}
            />
          )}

          {busy && cliOp && (
            <div className="pk-progress">
              <span>
                {busy.op === 'install' ? 'Installing ' : 'Removing '}
                <code>{busy.source}</code>…
              </span>
              <Button variant="secondary" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          )}

          {alert && (
            <div className={`pk-alert ${alert.level}`} role="status">
              {alert.text}
            </div>
          )}

          {list?.reloadRequired && (
            <div className="pk-alert reload" role="status">
              <LuInfo aria-hidden />
              <span>
                These declarations changed since pi started.{' '}
                {!ready
                  ? 'Pi will load them when it starts.'
                  : streaming
                    ? 'A run is in progress — reload afterwards.'
                    : 'Reload to load what the files say now.'}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={!ready || !!busy || streaming}
                title={
                  streaming
                    ? 'Reloading restarts the runtimes and aborts the run in progress'
                    : 'Restart the pi runtimes so they load these declarations'
                }
                onClick={reload}>
                Reload pi
              </Button>
            </div>
          )}

          {list &&
            !list.projectTrusted &&
            list.packages.some((entry) => entry.scope === 'project') && (
              <p className="pk-note">
                Project packages in <code>{list.projectSettingsFile}</code> are
                ignored until this folder is trusted.
              </p>
            )}

          {!!list?.errors.length && (
            <div className="pk-alert error" role="status">
              {list.errors.join('\n')}
            </div>
          )}

          {/* Both panels stay mounted: the Installed tab owns a filter and an open confirmation, and
              neither is anybody's business but the human's when they glance at Discover and back. */}
          <div className="pk-panel" hidden={tab !== 'installed'}>
            <InstalledList result={list} />
          </div>
          <div className="pk-panel" hidden={tab !== 'discover'}>
            <DiscoverPanel />
          </div>
        </div>

        <footer className="pk-foot">
          <span className="pk-foot-path" title={list?.userSettingsFile}>
            {list?.userSettingsFile ?? 'user settings'}
          </span>
          <span className="pk-foot-path" title={list?.projectSettingsFile}>
            {list?.projectSettingsFile ?? 'project settings'}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
