/**
 * Registry of the live webview surfaces (the sidebar view plus one panel per editor tab) that can show
 * a pi dialog, and the fan-out used to present one on all of them at once.
 *
 * Why fan-out instead of picking one surface: pi emits one `extension_ui_request` per dialog and parks the
 * tool call until it is answered, so the failure mode that matters is *nobody shows it*. The obvious
 * single-owner scheme — ask VS Code which webview is on screen and send it there — is unsound, because
 * `WebviewView.visible`/`WebviewPanel.visible` starts at `false` and is only pushed by
 * `onDidChangeVisibility`: a surface can be on screen while the flag still says it is not (and can keep
 * saying `true` after a view was re-resolved). Every surface therefore gets the dialog, and the host's
 * native fallback is decided afterwards by what the surfaces actually painted — see `ui-request-routing`.
 */

import type { ExtensionUiRequest } from '../../shared/protocol';
import type { PiRuntime } from '../runtime/pi-runtime';

/** One webview that a dialog can be shown in. Implemented by {@link ChatBridge}. */
export interface UiSurface {
  /** Name for the output-channel log (`sidebar`, `editor`). */
  readonly label: string;
  /**
   * VS Code's claim that this webview is on screen. Hint only — it is logged, never trusted; the ack from
   * the webview's own layout is what decides.
   */
  hostVisible(): boolean;
  /**
   * Render `request` here. Returns false when this surface cannot serve it (disposed, or bound to a
   * different runtime than the one that asked), because answering a dialog from the wrong child process
   * would leave the real one parked forever.
   */
  show(request: ExtensionUiRequest, source: PiRuntime): boolean;
  /** Drop a dialog this surface was showing: someone else answered it. */
  dismiss(id: string): void;
  /** True while this surface is still showing `id`. */
  isShowing(id: string): boolean;
}

const surfaces = new Set<UiSurface>();

/** Register a surface; returns the unregister function. */
export function registerUiSurface(surface: UiSurface): () => void {
  surfaces.add(surface);
  return () => surfaces.delete(surface);
}

/** Show `request` on every surface that can serve it; returns how many accepted. */
export function showUiRequest(
  request: ExtensionUiRequest,
  source: PiRuntime,
): number {
  let shown = 0;
  for (const surface of surfaces) {
    if (surface.show(request, source)) shown++;
  }
  return shown;
}

/** Tell every surface to drop `id` (it was answered elsewhere, natively or in another panel). */
export function dismissUiRequest(id: string): void {
  for (const surface of surfaces) surface.dismiss(id);
}

/** How many surfaces still have `id` on screen — used before cancelling an abandoned dialog. */
export function countSurfacesShowing(id: string): number {
  let count = 0;
  for (const surface of surfaces) {
    if (surface.isShowing(id)) count++;
  }
  return count;
}

/** Number of live surfaces (diagnostics and tests). */
export function uiSurfaceCount(): number {
  return surfaces.size;
}
