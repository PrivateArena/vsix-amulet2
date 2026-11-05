import {
  LuCircleArrowUp,
  LuChevronsUpDown,
  LuDownload,
  LuEyeOff,
  LuFileText,
  LuFolderOpen,
  LuInfo,
  LuKeyRound,
  LuMessageSquareWarning,
  LuMinimize2,
  LuRefreshCw,
  LuSettings,
  LuSettings2,
} from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import { usePrivacyMode, usePrivacyStore } from '../../../stores/privacy-store';
import { openProviderLogin } from '../../../stores/provider-login-store';
import { openSessionInfo } from '../../../stores/session-info-store';
import { Menu, MenuItem } from '../../ui/menu-item';

const REPO_URL = 'https://github.com/gunir/vsix-amulet2';

export function SettingsMenu() {
  const { session, expandThinking } = useChatState();
  const privacyMode = usePrivacyMode();
  // A rule that cannot compile is a secret that stays visible, so the menu says it rather than
  // leaving the human to find out from the output channel.
  const badRules = usePrivacyStore((s) => s.issues).length;

  const autoCompactionEnabled = session?.autoCompactionEnabled ?? true;

  const items: MenuItem[] = [
    {
      label: 'Submit Feedback',
      icon: LuMessageSquareWarning,
      onSelect: () => actions.openExternal(`${REPO_URL}/issues/new`),
    },
    {
      label: 'Log in to provider',
      icon: LuKeyRound,
      onSelect: () => openProviderLogin(),
    },
    {
      label: 'Open Pi folder',
      icon: LuFolderOpen,
      onSelect: () => actions.openPiFolder(),
    },
    {
      label: 'Force update Pi',
      icon: LuCircleArrowUp,
      onSelect: () => actions.updatePi(),
    },
    {
      label: 'Reload Pi config',
      icon: LuRefreshCw,
      onSelect: () => actions.restart(),
    },
    {
      label: 'Show session info',
      icon: LuInfo,
      onSelect: () => openSessionInfo(),
    },
    {
      label: badRules
        ? `Privacy mode (${badRules} rule${badRules > 1 ? 's' : ''} unusable)`
        : 'Privacy mode',
      icon: LuEyeOff,
      onSelect: () => actions.setPrivacyMode(!privacyMode),
      kind: 'toggle',
      checked: privacyMode,
    },
    {
      label: 'Uncollapse thinking',
      icon: LuChevronsUpDown,
      onSelect: () => actions.setExpandThinking(!expandThinking),
      kind: 'toggle',
      checked: expandThinking,
    },
    {
      label: 'Auto compact',
      icon: LuMinimize2,
      onSelect: () => actions.setAutoCompaction(!autoCompactionEnabled),
      kind: 'toggle',
      checked: autoCompactionEnabled,
    },
    {
      label: 'Export chat',
      icon: LuDownload,
      onSelect: () => actions.exportChat(),
    },
    {
      label: 'Changelog',
      icon: LuFileText,
      onSelect: () => actions.openExternal(`${REPO_URL}/releases`),
    },
    {
      label: 'Settings',
      icon: LuSettings,
      onSelect: () => actions.openSettings(),
    },
  ];

  return <Menu items={items} triggerIcon={LuSettings2} />;
}
