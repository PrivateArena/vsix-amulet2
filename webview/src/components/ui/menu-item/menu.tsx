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
import './menu.scss';

export interface MenuItem {
  label: string;
  icon: ComponentType<IconBaseProps>;
  onSelect: () => void;
  kind?: 'toggle';
  checked?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  triggerIcon?: ComponentType<IconBaseProps>;
  label?: string;
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
            aria-label={label}
            aria-haspopup="menu"
            title={label}
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
