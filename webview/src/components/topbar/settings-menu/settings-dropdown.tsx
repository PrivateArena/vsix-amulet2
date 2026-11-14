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
  LuPin,
  LuRefreshCw,
  LuSettings,
  LuSettings2,
  LuWrapText,
} from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import { usePrivacyMode, usePrivacyStore } from '../../../stores/privacy-store';
import { useLineBreaks } from '../../../stores/line-breaks-store';
import { useNotifySticky } from '../../../stores/notify-sticky-store';
import { openProviderLogin } from '../../../stores/provider-login-store';
import { openSessionInfo } from '../../../stores/session-info-store';
import { Menu, MenuItem } from '../../ui/menu-item';

const REPO_URL = 'https://github.com/gunir/vsix-amulet2';

export function SettingsMenu() {
  const { session, expandThinking } = useChatState();
  const privacyMode = usePrivacyMode();
  /** `amulet.preserveLineBreaks` — how the author's newlines are painted. */
  const lineBreaks = useLineBreaks();
  /** `amulet.notifySticky` — whether a parked dialog's system banner is kept until clicked. */
  const notifySticky = useNotifySticky();
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
      label: 'Line breaks',
      icon: LuWrapText,
      onSelect: () => actions.setPreserveLineBreaks(!lineBreaks),
      kind: 'toggle',
      checked: lineBreaks,
    },
    {
      // The one entry here that changes something outside the transcript, so the label says which
      // alert: off, an unanswered dialog is announced by a banner that expires like any other app's.
      label: 'Sticky approval alerts',
      icon: LuPin,
      onSelect: () => actions.setNotifySticky(!notifySticky),
      kind: 'toggle',
      checked: notifySticky,
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
