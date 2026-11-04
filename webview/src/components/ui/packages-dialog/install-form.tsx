import { useState } from 'react';
import { LuX } from 'react-icons/lu';
import type { PackageScope } from '../../../../../shared/protocol';
import {
  PACKAGE_SOURCE_FORMATS,
  PI_PACKAGES_URL,
  validatePackageSource,
} from '../../../../../shared/pi-packages';
import { actions } from '../../../apis/actions';
import { usePackagesStore } from '../../../stores/packages-store';
import { Button } from '../button';

export interface InstallFormProps {
  /** Folder pi runs in: `pi install` resolves a relative source against it, and a project install writes `<cwd>/.pi`. */
  cwd: string;
  /** Project installs need the folder trusted, so the scope choice says so instead of failing. */
  projectTrusted: boolean;
  busy: boolean;
}

/**
 * Install one package from a source string, into the user or the project settings scope.
 *
 * A free-text source rather than a picker, because the picker (pi's gallery) is the Discover tab:
 * what this form accepts is exactly what `pi install` accepts, and the gallery hands a human one of
 * these strings when they copy an install command.
 */
export function InstallForm({ cwd, projectTrusted, busy }: InstallFormProps) {
  const install = usePackagesStore((s) => s.install);
  const close = usePackagesStore((s) => s.setInstallOpen);
  const [source, setSource] = useState('');
  const [scope, setScope] = useState<PackageScope>('user');
  const problem = validatePackageSource(source);

  const submit = () => {
    if (problem || busy) return;
    install(source.trim(), scope);
    setSource('');
  };

  return (
    <form
      className="pk-install"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}>
      <div className="pk-install-head">
        <span className="pk-install-title">Install a pi package</span>
        <button
          type="button"
          className="pk-link"
          aria-label="Close the install form"
          onClick={() => close(false)}>
          <LuX aria-hidden />
        </button>
      </div>

      <div className="pk-install-row">
        <input
          className="pk-install-input"
          type="text"
          value={source}
          autoFocus
          spellCheck={false}
          placeholder="npm:name · git:github.com/owner/repo · ./path"
          aria-label="Package source"
          onChange={(e) => setSource(e.target.value)}
        />
        <Button
          type="submit"
          variant="contained"
          disabled={!!problem || busy}
          title={problem ?? `Install ${source.trim() || 'this package'}`}>
          {busy ? 'Working…' : 'Install'}
        </Button>
      </div>

      <div
        className="pk-install-scopes"
        role="group"
        aria-label="Install scope">
        {(['user', 'project'] as PackageScope[]).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={scope === option}
            disabled={option === 'project' && !projectTrusted}
            title={
              option === 'project' && !projectTrusted
                ? 'Trust this folder first — pi only reads its .pi/settings.json after that'
                : option === 'project'
                  ? `Write to ${cwd}/.pi/settings.json`
                  : 'Write to the pi agent settings file'
            }
            className={`pk-scope${scope === option ? ' is-active' : ''}`}
            onClick={() => setScope(option)}>
            {option === 'user' ? 'User' : 'Project'}
          </button>
        ))}
      </div>

      <ul className="pk-formats">
        {PACKAGE_SOURCE_FORMATS.map((format) => (
          <li key={format.example}>
            <code>{format.example}</code>
            <span>{format.hint}</span>
          </li>
        ))}
      </ul>

      {problem && source.length > 0 && (
        <p className="pk-error-text">{problem}</p>
      )}

      <p className="pk-install-foot">
        Runs <code>pi install</code>, so it needs the network and may take a
        while.{' '}
        <button
          type="button"
          className="pk-link"
          onClick={() => actions.openExternal(PI_PACKAGES_URL)}>
          Browse {PI_PACKAGES_URL.replace(/^https:\/\//, '')}
        </button>
      </p>
    </form>
  );
}
