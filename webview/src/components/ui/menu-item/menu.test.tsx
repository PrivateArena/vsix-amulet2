import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LuEyeOff } from 'react-icons/lu';
import { Menu } from './menu';

// Only the trigger renders here: the popover is a Flyout, and its items (whose ids derive
// from the menu id — see `menuItemId`, covered in `utils/control-id.test.ts`) mount on open.
const items = [
  {
    label: 'Privacy mode',
    id: 'privacy-mode',
    icon: LuEyeOff,
    onSelect: () => {},
  },
  { label: 'Export chat', icon: LuEyeOff, onSelect: () => {} },
];

describe('Menu ids', () => {
  it('names an icon-only trigger so it can be pointed at', () => {
    const html = renderToStaticMarkup(
      <Menu items={items} id="preferences-menu" triggerLabel="Preferences" />,
    );
    expect(html).toContain('id="preferences-menu"');
    expect(html).toContain('title="Preferences"');
    expect(html).toContain('aria-label="Preferences"');
  });

  it('stays id-less when the caller has not named the menu', () => {
    const html = renderToStaticMarkup(<Menu items={items} />);
    expect(html).not.toContain('id="preferences-menu');
  });
});
