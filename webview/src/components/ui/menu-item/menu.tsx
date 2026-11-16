import { ComponentType, useCallback } from 'react';
import { IconBaseProps } from 'react-icons';
import { LuCheck, LuChevronDown } from 'react-icons/lu';
import { Button } from '../button';
import {
  Flyout,
  PopoverAlign,
  PopoverSide,
  PopoverTriggerApi,
} from '../flyout';
import { menuItemId } from '../../../utils/control-id';
import './menu.scss';

export interface MenuItem {
  label: string;
  /**
   * Stable part of this item's DOM id. Only needed when `label` is not a fixed string —
   * see {@link menuItemId}.
   */
  id?: string;
  icon: ComponentType<IconBaseProps>;
  onSelect: () => void;
  kind?: 'toggle';
  checked?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  triggerIcon?: ComponentType<IconBaseProps>;
  /** Visible text of the trigger button. */
  label?: string;
  /**
   * Hover + accessible name of an icon-only trigger ("Preferences"). Without it a gear is
   * unnamed — nothing to read, nothing to quote.
   */
  triggerLabel?: string;
  /**
   * Id of the trigger button, and the namespace of the item ids: item "Privacy mode" of
   * `id="preferences-menu"` is `#preferences-menu-privacy-mode`.
   */
  id?: string;
  side?: PopoverSide;
  align?: PopoverAlign;
  minWidth?: number;
  trigger?: (api: PopoverTriggerApi) => React.ReactNode;
  /** Fired when the menu opens - use it to refresh host-backed option lists. */
  onOpen?: () => void;
}

export function Menu({
  items,
  triggerIcon = LuChevronDown,
  label,
  triggerLabel,
  id,
  side = 'bottom-right',
  align = 'center',
  minWidth = 198,
  trigger,
  onOpen,
}: MenuProps) {
  // Stable identity so the Flyout does not re-subscribe its document listeners.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) onOpen?.();
    },
    [onOpen],
  );
  return (
    <Flyout
      side={side}
      align={align}
      minWidth={minWidth}
      popoverProps={{ role: 'menu' }}
      onOpenChange={handleOpenChange}
      trigger={
        trigger ??
        (({ ref, triggerProps }) => (
          <Button
            ref={ref}
            variant="ghost"
            icon={triggerIcon}
            id={id}
            aria-label={triggerLabel ?? label}
            aria-haspopup="menu"
            title={triggerLabel ?? label}
            {...triggerProps}>
            {label}
          </Button>
        ))
      }>
      {({ close }) => (
        <div style={{ padding: '.25rem' }}>
          {items.map((item, i) => (
            <Button
              key={`${item.label}#${i}`}
              type="button"
              role="menuitem"
              id={id ? menuItemId(id, item) : undefined}
              className={`menu-item${item.kind === 'toggle' ? ' menu-toggle' : ''}${item.disabled ? ' disabled' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                close();
              }}>
              <span className="menu-icon">
                <item.icon size={14} />
              </span>
              <span className="menu-label">{item.label}</span>
              {item.kind === 'toggle' && item.checked && <LuCheck size={14} />}
            </Button>
          ))}
        </div>
      )}
    </Flyout>
  );
}
