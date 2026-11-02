import { useEffect } from 'react';
import { CTX_MENU_CLASS } from '../components/ui/ctx-menu';

/**
 * Run `callback` on Escape — unless a context menu is open. The menu dismisses itself
 * on that key, and its listener runs first: while its node is in the DOM the menu owns
 * Escape, so the key must not also reach the surface underneath, which for the shell
 * means aborting a streaming run.
 */
export function useEscapeKey(callback: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector(`.${CTX_MENU_CLASS}`)) return;
      callback();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [callback, enabled]);
}
