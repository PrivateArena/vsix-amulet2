import {
  ComponentType,
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IconBaseProps } from 'react-icons';
import { menuItemId } from '../../../utils/control-id';
import './ctx-menu.scss';

/** Root class of the menu, also the marker Escape checks for. */
export const CTX_MENU_CLASS = 'ctx-menu';

export interface ContextMenuItem {
  label: string;
  /**
   * Stable part of this item's DOM id — only needed when `label` is not a fixed string,
   * see {@link menuItemId}.
   */
  id?: string;
  hint?: string;
  icon?: ComponentType<IconBaseProps>;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /**
   * Id of this menu, and the namespace of its item ids: item "Quote" of `id="transcript-menu"`
   * is `#transcript-menu-quote`. Without it the items of a menu are unnamed to a selector — the
   * same reason {@link Menu} takes one.
   */
  id?: string;
  onClose: () => void;
  minWidth?: number;
}

export function CtxMenu({
  x,
  y,
  items,
  id,
  onClose,
  minWidth = 200,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + w > vw - margin) left = Math.max(margin, x - w);
    if (left + w > vw - margin) left = Math.max(margin, vw - margin - w);
    if (top + h > vh - margin) top = Math.max(margin, y - h);
    if (top + h > vh - margin) top = Math.max(margin, vh - margin - h);
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('contextmenu', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('contextmenu', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className={CTX_MENU_CLASS}
      id={id}
      role="menu"
      style={{ left: pos.left, top: pos.top, minWidth }}
      onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {item.separatorBefore && i > 0 && (
            <div className="ctx-separator" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            id={id ? menuItemId(id, item) : undefined}
            className={`ctx-item${item.disabled ? ' disabled' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}>
            {item.icon && (
              <span className="ctx-item-icon">
                <item.icon size={14} />
              </span>
            )}
            <span className="ctx-item-label">{item.label}</span>
            {item.hint && <span className="ctx-item-hint">{item.hint}</span>}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
