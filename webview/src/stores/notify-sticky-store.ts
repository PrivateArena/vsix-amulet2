import { create } from 'zustand';
import type { WebviewConfig } from '../../../shared/protocol';

/**
 * The OS-alert stickiness preference (menu: **Sticky approval alerts**, `amulet.notifySticky`).
 *
 * Host-owned state exactly like Privacy mode and Line breaks: the value arrives in the `config`
 * HostMessage and the webview only ever asks the host to write it, so the Settings editor, another
 * surface and this menu cannot disagree about it. It differs from those two in where the value is
 * *used* — the host, at delivery time, never the transcript — which is why this store renders a
 * checkmark and nothing else.
 *
 * Off (the default) sends the alert for an unanswered dialog as an ordinary banner, which expires like
 * every other application's. On asks for the `critical` tier instead, which survives Do-Not-Disturb on
 * servers that implement it — and, by the freedesktop convention, is never timed out: a notification
 * centre that follows it keeps the banner until a human clicks it away.
 */

interface NotifyStickyState {
  /** A parked dialog's banner is critical, i.e. kept until dismissed. */
  sticky: boolean;
}

/** The manifest default, so the first paint is right before the host's `config` lands. */
const NOTIFY_STICKY_DEFAULT = false;

export const useNotifyStickyStore = create<NotifyStickyState>(() => ({
  sticky: NOTIFY_STICKY_DEFAULT,
}));

/** Apply the notify half of a `config` push; ignore anything that did not change. */
export function applyNotifyStickyConfig(config: WebviewConfig): void {
  const next = config.notifySticky;
  if (useNotifyStickyStore.getState().sticky === next) return;
  useNotifyStickyStore.setState({ sticky: next });
}

/** Whether an unanswered dialog's banner is kept on screen — the menu checkmark. */
export function useNotifySticky(): boolean {
  // Subscribe so a flip repaints the menu, then read the live value: `useSyncExternalStore` answers with
  // the *initial* state while rendering on a server, so a selected value would be the shipped default in
  // a test render no matter what the setting said. `useLineBreaks` does the same.
  useNotifyStickyStore((s) => s.sticky);
  return useNotifyStickyStore.getState().sticky;
}
