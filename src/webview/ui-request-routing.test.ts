import { describe, expect, it } from 'vitest';
import {
  claimUiRequest,
  releaseUiRequest,
  routeUiRequest,
} from './ui-request-routing';

describe('routeUiRequest', () => {
  it('shows dialogs in the chat panel when this surface is visible', () => {
    for (const method of ['select', 'confirm', 'input', 'editor']) {
      expect(
        routeUiRequest(method, { selfVisible: true, anyVisible: true }),
      ).toBe('webview');
    }
  });

  it('skips a dialog on a hidden surface when another one is on screen', () => {
    // The visible panel answers; a native QuickPick here would race it for the same request id.
    expect(
      routeUiRequest('select', { selfVisible: false, anyVisible: true }),
    ).toBe('skip');
  });

  it('falls back to a native dialog when nothing is visible (e.g. background run)', () => {
    expect(
      routeUiRequest('select', { selfVisible: false, anyVisible: false }),
    ).toBe('native');
  });

  it('routes fire-and-forget methods natively, wherever the surfaces are', () => {
    for (const method of ['notify', 'setStatus', 'setTitle', 'setWidget']) {
      expect(
        routeUiRequest(method, { selfVisible: true, anyVisible: true }),
      ).toBe('native');
    }
  });
});

describe('claimUiRequest', () => {
  it('lets the first bridge own a request and rejects the rest', () => {
    expect(claimUiRequest('dup-1', 'webview')).toBe(true);
    expect(claimUiRequest('dup-1', 'native')).toBe(false);
    expect(claimUiRequest('dup-1', 'webview')).toBe(false);
    releaseUiRequest('dup-1');
  });

  it('frees the id once the answer went back to the runtime', () => {
    expect(claimUiRequest('dup-2', 'webview')).toBe(true);
    releaseUiRequest('dup-2');
    expect(claimUiRequest('dup-2', 'webview')).toBe(true);
    releaseUiRequest('dup-2');
  });

  it('tracks distinct request ids independently', () => {
    expect(claimUiRequest('a-1', 'webview')).toBe(true);
    expect(claimUiRequest('b-1', 'native')).toBe(true);
    releaseUiRequest('a-1');
    releaseUiRequest('b-1');
  });

  it('evicts the oldest claim past the cap, so abandoned requests cannot grow the map', () => {
    const ids = Array.from({ length: 70 }, (_, i) => `leak-${i}`);
    for (const id of ids) expect(claimUiRequest(id, 'native')).toBe(true);
    // Only the most recent MAX_CLAIMS are held, so the first one is claimable again…
    expect(claimUiRequest('leak-0', 'native')).toBe(true);
    // …while the newest is still owned.
    expect(claimUiRequest(ids[69]!, 'native')).toBe(false);
    for (const id of ids) releaseUiRequest(id);
    releaseUiRequest('leak-0');
  });
});
