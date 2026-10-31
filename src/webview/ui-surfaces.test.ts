import { describe, expect, it } from 'vitest';
import {
  hasVisibleUiSurface,
  registerUiSurface,
  uiSurfaceCount,
} from './ui-surfaces';

describe('ui surfaces', () => {
  it('reports no visible surface while nothing is registered', () => {
    expect(uiSurfaceCount()).toBe(0);
    expect(hasVisibleUiSurface()).toBe(false);
  });

  it('sees a surface through its own visibility probe (VS Code flips `visible` without telling us)', () => {
    let visible = false;
    const off = registerUiSurface(() => visible);
    expect(hasVisibleUiSurface()).toBe(false);
    visible = true;
    expect(hasVisibleUiSurface()).toBe(true);
    off();
    expect(hasVisibleUiSurface()).toBe(false);
  });

  it('is visible if any one of several surfaces is visible, and only while it is registered', () => {
    const offSidebar = registerUiSurface(() => false);
    const offPanel = registerUiSurface(() => true);
    expect(uiSurfaceCount()).toBe(2);
    expect(hasVisibleUiSurface()).toBe(true);
    offPanel();
    expect(hasVisibleUiSurface()).toBe(false);
    offSidebar();
    expect(uiSurfaceCount()).toBe(0);
  });

  it('unregistering twice is harmless', () => {
    const off = registerUiSurface(() => true);
    off();
    off();
    expect(uiSurfaceCount()).toBe(0);
  });
});
