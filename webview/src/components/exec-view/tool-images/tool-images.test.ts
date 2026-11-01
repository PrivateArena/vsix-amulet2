import { describe, expect, it, vi } from 'vitest';
import type { ToolImageRef } from '../../../../../shared/protocol';

// `needsToolImage` ships with the tile that uses it, and that tile reaches the host through
// `apis/actions`, which takes hold of the VS Code API as it is imported. No webview here.
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));
const { needsToolImage } = await import('./tool-images');

const ref = (patch: Partial<ToolImageRef> = {}): ToolImageRef => ({
  path: 'tmp/shot.png',
  mimeType: 'image/png',
  bytes: 4096,
  ...patch,
});

/**
 * The gate the whole lazy behaviour rests on: a collapsed card must not put a request on
 * the host, because that is what keeps a megabyte of pixels out of the renderer for a
 * result nobody is looking at.
 */
describe('needsToolImage', () => {
  it('asks only once the card is open', () => {
    expect(needsToolImage(ref(), false)).toBe(false);
    expect(needsToolImage(ref(), true)).toBe(true);
  });

  it('stops asking once the bytes are in, or once reading failed', () => {
    expect(
      needsToolImage(ref({ dataUrl: 'data:image/png;base64,QUJD' }), true),
    ).toBe(false);
    expect(
      needsToolImage(ref({ error: 'no file at tmp/shot.png' }), true),
    ).toBe(false);
  });

  it('never asks for an image with no file behind it', () => {
    expect(needsToolImage(ref({ path: undefined }), true)).toBe(false);
  });
});
