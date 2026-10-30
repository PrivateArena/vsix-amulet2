import { useCallback, useEffect, useRef, useState } from 'react';
import { actions } from '../apis/actions';

/** How long a "Copied" confirmation stays visible. */
const COPIED_FEEDBACK_MS = 1400;

/**
 * Copy text through the host and report the confirmation.
 *
 * The webview has no clipboard access of its own, so every copy goes to
 * `vscode.env.clipboard` on the extension host. `copied` flips back on a timer that
 * is cleared on unmount, so a row can show a check for a moment without leaking.
 */
export function useCopyFeedback(): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback((text: string) => {
    if (!text) return;
    actions.copyText(text);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setCopied(false),
      COPIED_FEEDBACK_MS,
    );
  }, []);

  return { copied, copy };
}
