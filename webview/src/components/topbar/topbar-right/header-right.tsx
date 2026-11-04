import { LuExternalLink, LuPackage, LuSquarePen } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { openPackages } from '../../../stores/packages-store';
import { SessionDropdown } from '../../session-dd';
import { Button } from '../../ui/button';
import { SettingsMenu } from '../settings-menu';
import './header-right.scss';

export function TopbarRight() {
  return (
    <div className="topbar-right">
      <Button
        variant="ghost"
        icon={LuPackage}
        aria-label="Pi packages"
        title="Pi packages"
        onClick={() => openPackages()}
      />
      <SettingsMenu />
      <Button
        variant="ghost"
        icon={LuExternalLink}
        aria-label="Open chat in editor"
        title="Open chat in editor"
        onClick={() => actions.openInEditor()}
      />
      <SessionDropdown />
      <Button
        variant="ghost"
        icon={LuSquarePen}
        aria-label="New chat"
        title="New chat"
        onClick={() => actions.newChat()}
      />
    </div>
  );
}
