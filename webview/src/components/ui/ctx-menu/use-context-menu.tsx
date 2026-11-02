import { useCallback, useRef, useState } from 'react';
import { CtxMenu, ContextMenuItem } from './context-menu';

export interface UseContextMenuOptions {
  minWidth?: number;
  /** Runs when the menu dismisses, however it was dismissed. */
  onClose?: () => void;
}

/** Static items, or a factory that decides them at the moment of the right-click. */
export type ContextMenuItems =
  ContextMenuItem[] | ((e: React.MouseEvent) => ContextMenuItem[] | null);

export interface UseContextMenu {
  /** `onContextMenu` handler — opens the menu at the cursor. */
  open: (e: React.MouseEvent) => void;
  /** Dismiss the menu. */
  close: () => void;
  /** Whether the menu is currently open. */
  isOpen: boolean;
  /** The rendered menu (or `null`). Drop this into your JSX. */
  menu: React.ReactNode;
}

/**
 * Owns the open/close + cursor-anchor state for a {@link ContextMenu}.
 *
 * ```tsx
 * const ctx = useContextMenu(items);
 * return (
 *   <>
 *     <Button onContextMenu={ctx.open}>…</Button>
 *     {ctx.menu}
 *   </>
 * );
 * ```
 *
 * Given a factory, it runs on the right-click: a menu that decides it has nothing to
 * offer leaves the event alone, so the native menu still shows.
 */
export function useCtxMenu(
  items: ContextMenuItems,
  options: UseContextMenuOptions = {},
): UseContextMenu {
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const { minWidth, onClose } = options;
  // Refs, so `close` and `open` keep one identity across renders but still see the
  // latest callback and the live open state.
  const notifyClose = useRef(onClose);
  notifyClose.current = onClose;
  const opened = useRef(false);

  const close = useCallback(() => {
    const wasOpen = opened.current;
    opened.current = false;
    setAnchor(null);
    if (wasOpen) notifyClose.current?.();
  }, []);

  const open = useCallback(
    (e: React.MouseEvent) => {
      const list = typeof items === 'function' ? items(e) : items;
      if (!list || list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      opened.current = true;
      setAnchor({ x: e.clientX, y: e.clientY, items: list });
    },
    [items],
  );

  const menu = anchor ? (
    <CtxMenu
      x={anchor.x}
      y={anchor.y}
      items={anchor.items}
      onClose={close}
      minWidth={minWidth}
    />
  ) : null;

  return { open, close, isOpen: anchor !== null, menu };
}
