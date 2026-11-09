import { create } from 'zustand';
import type { WebviewConfig } from '../../../shared/protocol';

/**
 * The transcript's line-break preference (menu: **Line breaks**, `amulet.preserveLineBreaks`).
 *
 * Host-owned state exactly like Privacy mode: the value arrives in the `config` HostMessage and the
 * webview only ever asks the host to write it — the Settings editor, another surface and this menu
 * all stay in agreement because none of them owns the number.
 *
 * It is a switch and not a bug fix by decree because the two readings genuinely differ. Most
 * authors type line-first and want `⏎` to break the line; a model that hard-wraps its prose at a
 * column wants markdown's rule, where a single newline is whitespace and only a blank line means
 * "new paragraph". Both are the same bytes on the wire: this never touches what a message *says* —
 * not the session file, not the prompt, not a copy — only how one of its paragraphs is painted.
 */

interface LineBreakState {
  /** A newline the author typed paints as a line break. */
  preserved: boolean;
}

/** The manifest default, so the first paint is right before the host's `config` lands. */
const PRESERVE_LINE_BREAKS_DEFAULT = true;

export const useLineBreaksStore = create<LineBreakState>(() => ({
  preserved: PRESERVE_LINE_BREAKS_DEFAULT,
}));

/** Apply the line-break half of a `config` push; ignore anything that did not change. */
export function applyLineBreakConfig(config: WebviewConfig): void {
  const next = config.preserveLineBreaks;
  if (useLineBreaksStore.getState().preserved === next) return;
  useLineBreaksStore.setState({ preserved: next });
}

/** Whether a typed newline is a line break — the menu checkmark and every text leaf. */
export function useLineBreaks(): boolean {
  // Subscribe so a flip repaints, then read the live value: `useSyncExternalStore` answers with
  // the *initial* state while rendering on a server, so a selected value would be the shipped
  // default in a test render no matter what the setting said. `useRedact` does the same.
  useLineBreaksStore((s) => s.preserved);
  return useLineBreaksStore.getState().preserved;
}
