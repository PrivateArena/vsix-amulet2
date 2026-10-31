/**
 * Who owns one `extension_ui_request`.
 *
 * Every live {@link ChatBridge} subscribes to the same runtime, so pi's dialogs and notifications are
 * delivered to each surface (the sidebar view plus one panel per editor tab). Answering twice is worse
 * than answering late: pi resolves the pending dialog on the *first* response, so the other surfaces are
 * left showing a prompt nobody can dismiss, and — for a `tool_call` gate — the agent stays parked behind a
 * question that was already answered elsewhere. Hence: decide the route, then claim it, once.
 */

import { MODAL_UI_METHODS } from '../../shared/protocol';

const MODAL_METHOD_SET: ReadonlySet<string> = new Set(MODAL_UI_METHODS);

/** Where the request would be presented. `skip` means another surface is responsible. */
export type UiRoute = 'webview' | 'native' | 'skip';

export interface UiSurfaceState {
  /** This bridge's own webview is on screen. */
  selfVisible: boolean;
  /** Any webview surface is on screen — see {@link hasVisibleUiSurface}. */
  anyVisible: boolean;
}

/**
 * A modal dialog belongs in the chat panel when one is visible (a native QuickPick would otherwise be
 * grabbed by whichever bridge registered first, including a hidden one). With nothing on screen the
 * dialog has to fall back to VS Code, or the run would wait forever.
 */
export function routeUiRequest(
  method: string,
  surfaces: UiSurfaceState,
): UiRoute {
  if (!MODAL_METHOD_SET.has(method)) return 'native';
  if (surfaces.selfVisible) return 'webview';
  return surfaces.anyVisible ? 'skip' : 'native';
}

const MAX_CLAIMS = 64;

const claims = new Map<string, UiRoute>();

/** True when this bridge owns `id`; false when another surface already claimed it. */
export function claimUiRequest(id: string, route: UiRoute): boolean {
  if (claims.has(id)) return false;
  while (claims.size >= MAX_CLAIMS) {
    const oldest = claims.keys().next();
    if (oldest.done) break;
    claims.delete(oldest.value);
  }
  claims.set(id, route);
  return true;
}

/** Stop tracking `id` once its answer went back to the runtime (or the owning surface is gone). */
export function releaseUiRequest(id: string): void {
  claims.delete(id);
}
