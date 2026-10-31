/**
 * Registry of the webview surfaces that are currently alive (the sidebar view plus one panel per
 * editor tab). Each {@link ChatBridge} registers an accessor for its own visibility on construction
 * and unregisters on dispose.
 *
 * Why the host needs this: pi emits one `extension_ui_request` per dialog and blocks the tool call until
 * it is answered, so exactly one surface must own it. A hidden surface must not answer natively while a
 * visible one could have shown the in-chat dialog — otherwise the QuickPick steals the answer from a panel
 * the human is looking at, depending on listener order.
 */

const surfaces = new Set<() => boolean>();

/** Register a surface's visibility probe; returns the unregister function. */
export function registerUiSurface(isVisible: () => boolean): () => void {
  surfaces.add(isVisible);
  return () => surfaces.delete(isVisible);
}

export function hasVisibleUiSurface(): boolean {
  for (const isVisible of surfaces) {
    if (isVisible()) return true;
  }
  return false;
}

/** Number of live surfaces (diagnostics and tests). */
export function uiSurfaceCount(): number {
  return surfaces.size;
}
