import { describe, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../shared/protocol';
import {
  countSurfacesShowing,
  dismissUiRequest,
  registerUiSurface,
  showUiRequest,
  uiSurfaceCount,
} from './ui-surfaces';

const runtime = {} as never; // only identity matters here

interface Fake {
  /** The bridge behind the surface; `false` when it cannot serve the request. */
  serves: boolean;
  shown: string[];
  dismissed: string[];
}

function surface(label: string, fake: Fake) {
  const shown = new Set<string>();
  return registerUiSurface({
    label,
    hostVisible: () => true,
    show: (request: ExtensionUiRequest) => {
      if (!fake.serves) return false;
      shown.add(request.id);
      fake.shown.push(request.id);
      return true;
    },
    dismiss: (id: string) => {
      shown.delete(id);
      fake.dismissed.push(id);
    },
    isShowing: (id: string) => shown.has(id),
  });
}

describe('ui surfaces', () => {
  it('has nobody to ask while nothing is registered', () => {
    expect(uiSurfaceCount()).toBe(0);
    expect(
      showUiRequest(
        { type: 'extension_ui_request', id: 'x', method: 'select' },
        runtime,
      ),
    ).toBe(0);
  });

  it('fans one request out to every live surface and counts those that took it', () => {
    const sidebar: Fake = { serves: true, shown: [], dismissed: [] };
    const hidden: Fake = { serves: false, shown: [], dismissed: [] };
    const offSidebar = surface('sidebar', sidebar);
    const offHidden = surface('editor', hidden);
    expect(uiSurfaceCount()).toBe(2);
    expect(
      showUiRequest(
        { type: 'extension_ui_request', id: 'a', method: 'select' },
        runtime,
      ),
    ).toBe(1);
    expect(sidebar.shown).toEqual(['a']);
    expect(hidden.shown).toEqual([]);
    offHidden();
    offSidebar();
    expect(uiSurfaceCount()).toBe(0);
  });

  it('dismisses every surface so only one answer can be given', () => {
    const first: Fake = { serves: true, shown: [], dismissed: [] };
    const second: Fake = { serves: true, shown: [], dismissed: [] };
    const offFirst = surface('sidebar', first);
    const offSecond = surface('editor', second);
    const request = {
      type: 'extension_ui_request',
      id: 'd',
      method: 'confirm',
    } as const;
    showUiRequest(request, runtime);
    expect(countSurfacesShowing('d')).toBe(2);
    dismissUiRequest('d');
    expect(first.dismissed).toEqual(['d']);
    expect(second.dismissed).toEqual(['d']);
    expect(countSurfacesShowing('d')).toBe(0);
    offFirst();
    offSecond();
  });

  it('unregistering twice is harmless', () => {
    const fake: Fake = { serves: true, shown: [], dismissed: [] };
    const off = surface('panel', fake);
    off();
    off();
    expect(uiSurfaceCount()).toBe(0);
  });
});
