import { create } from 'zustand';
import type { WebviewConfig } from '../../../shared/protocol';

/**
 * The two OS-alert preferences (menu: **Sticky approval alerts** and **Click to focus**,
 * `amulet.notifySticky` / `amulet.notifyClickToFocus`).
 *
 * Host-owned state exactly like Privacy mode and Line breaks: the values arrive in the `config`
 * HostMessage and the webview only ever asks the host to write them, so the Settings editor, another
 * surface and this menu cannot disagree about them. They differ from those two in where the value is
 * *used* — the host, at delivery time, never the transcript — which is why this store renders two
 * checkmarks and nothing else.
 *
 * Sticky, off: the alert for an unanswered dialog is an ordinary banner that expires like every other
 * application's. On: it asks for the `critical` tier, which survives Do-Not-Disturb on servers that
 * implement it — and, by the freedesktop convention, is never timed out.
 *
 * Click to focus, on: a banner carries an action whose click raises this VS Code window. Only an
 * expiring banner can do that, because the click has to be caught by a process that waits for it —
 * so the two switches are alternatives in exactly one case, and the host decides which wins.
 */

interface NotifyState {
  /** A parked dialog's banner is critical, i.e. kept until dismissed. */
  sticky: boolean;
  /** A banner offers an action that raises the VS Code window when clicked. */
  clickToFocus: boolean;
}

/** The manifest defaults, so the first paint is right before the host's `config` lands. */
const NOTIFY_STICKY_DEFAULT = false;
const NOTIFY_CLICK_DEFAULT = true;

export const useNotifyStore = create<NotifyState>(() => ({
  sticky: NOTIFY_STICKY_DEFAULT,
  clickToFocus: NOTIFY_CLICK_DEFAULT,
}));

/** Apply the notify half of a `config` push; ignore anything that did not change. */
export function applyNotifyConfig(config: WebviewConfig): void {
  const current = useNotifyStore.getState();
  if (
    current.sticky === config.notifySticky &&
    current.clickToFocus === config.notifyClickToFocus
  ) {
    return;
  }
  useNotifyStore.setState({
    sticky: config.notifySticky,
    clickToFocus: config.notifyClickToFocus,
  });
}

function useNotifyFlag(read: (s: NotifyState) => boolean): boolean {
  // Subscribe so a flip repaints the menu, then read the live value: `useSyncExternalStore` answers with
  // the *initial* state while rendering on a server, so a selected value would be the shipped default in
  // a test render no matter what the setting said. `useLineBreaks` does the same.
  useNotifyStore(read);
  return read(useNotifyStore.getState());
}

/** Whether an unanswered dialog's banner is kept on screen — the menu checkmark. */
export function useNotifySticky(): boolean {
  return useNotifyFlag((s) => s.sticky);
}

/** Whether a banner may raise the window when clicked — the menu checkmark. */
export function useNotifyClickToFocus(): boolean {
  return useNotifyFlag((s) => s.clickToFocus);
}
