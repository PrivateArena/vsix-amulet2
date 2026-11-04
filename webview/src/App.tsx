import { Shell } from './app-shell';
import { Modal } from './components/ui/modal';
import { AuthDialog } from './components/ui/auth-dialog';
import { PermissionPrompt } from './components/ui/permission-prompt';
import { SessionInfoDialog } from './components/ui/session-info-dialog';
import { PackagesDialog } from './components/ui/packages-dialog';
import { CompactionDialog } from './components/ui/compaction-dialog';
import { ChatCtx } from './contexts/chat-context';

import './assets/css/styles.scss';
import './assets/css/theme.scss';

export function App() {
  return (
    <ChatCtx>
      <Shell />
      <Modal />
      <AuthDialog />
      <PermissionPrompt />
      <SessionInfoDialog />
      <CompactionDialog />
      <PackagesDialog />
    </ChatCtx>
  );
}
