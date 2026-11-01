/**
 * The lifecycle of one `extension_ui_request` that needs an answer.
 *
 * Every live {@link ChatBridge} subscribes to the same runtime, so pi's dialog reaches every surface and
 * pi resolves the pending question on the *first* response. Two invariants follow, and both live here so
 * no bridge can get them wrong on its own:
 *
 * 1. **Exactly one answer per id.** `beginUiRequest` elects the orchestrator for a request, and
 *    `answerUiRequest` only lets one response through — from a webview, from a second surface that also
 *    rendered it, from a surface that closed mid-dialog, or from the native fallback. A double answer would
 *    resolve a *later* pi question with the first dialog's id.
 * 2. **The human always sees something.** The requesting surface shows the dialog on all surfaces, then
 *    waits for one of them to prove (by measuring its own layout — `extensionUiShown`) that it really
 *    painted it. Nothing proving that within {@link UI_DIALOG_ACK_TIMEOUT_MS} — no surface at all, only
 *    hidden ones, or a webview whose messages are being dropped — hands the question to VS Code's native
 *    dialog instead of parking the tool call forever.
 */

import {
  MODAL_UI_METHODS,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
} from '../../shared/protocol';

const MODAL_METHOD_SET: ReadonlySet<string> = new Set(MODAL_UI_METHODS);

/** Grace period for a surface to report that it painted the dialog. */
export const UI_DIALOG_ACK_TIMEOUT_MS = 1_500;

/** Bound on tracked requests, so an abandoned id can't grow the map. */
const MAX_PENDING = 64;

/** What the owning bridge provides so this module stays free of `vscode` and runtime types. */
export interface DialogDeps {
  /** Ask VS Code (QuickPick / modal message) — the fallback when no webview showed the dialog. */
  fallbackToNative(
    request: ExtensionUiRequest,
  ): Promise<ExtensionUiResponse | null>;
  /** Hand the answer back to the child process that asked. */
  respond(response: ExtensionUiResponse): void;
  /** Tell all surfaces to drop this dialog (another surface or VS Code answered it). */
  dismiss(id: string): void;
  log(text: string): void;
}

interface PendingDialog {
  request: ExtensionUiRequest;
  deps: DialogDeps;
  /** Surfaces the request was posted to, for the fallback log line. */
  surfaces: number;
  /** A surface proved it painted the dialog on screen — no native dialog needed. */
  acked: boolean;
  /** The single answer slot is taken, so any later answer is dropped. */
  answered: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingDialog>();

/** True when `method` blocks the tool call until it is answered. */
export function isModalUiMethod(method: string): boolean {
  return MODAL_METHOD_SET.has(method);
}

/** True while this module is still tracking `id` (diagnostics and tests). */
export function isTrackingUiRequest(id: string): boolean {
  return pending.has(id);
}

/** Claim `id` as its orchestrator; false when another bridge already owns it. */
export function beginUiRequest(
  request: ExtensionUiRequest,
  deps: DialogDeps,
): boolean {
  if (pending.has(request.id)) return false;
  while (pending.size >= MAX_PENDING) evictOldest();
  pending.set(request.id, {
    request,
    deps,
    surfaces: 0,
    acked: false,
    answered: false,
  });
  return true;
}

/**
 * Start watching a claimed request. `shown` is how many surfaces accepted it; zero means there is nobody
 * to ask, so VS Code answers straight away.
 */
export function armUiRequest(id: string, shown: number): void {
  const entry = pending.get(id);
  if (!entry || entry.answered) return;
  entry.surfaces = shown;
  if (shown === 0) {
    void runNativeFallback(id, 'no live surface');
    return;
  }
  entry.timer = setTimeout(
    () =>
      void runNativeFallback(
        id,
        `nobody painted it in ${UI_DIALOG_ACK_TIMEOUT_MS}ms`,
      ),
    UI_DIALOG_ACK_TIMEOUT_MS,
  );
}

/**
 * Record one surface's proof that it painted the dialog. Only a `visible` ack (non-zero layout, document
 * not hidden) settles the decision — a hidden webview still runs its scripts and would otherwise suppress
 * the native dialog while nobody is looking at it.
 */
export function ackUiRequest(id: string, visible: boolean): boolean {
  const entry = pending.get(id);
  if (!entry || entry.answered) return false;
  if (!visible) return true;
  entry.acked = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  return true;
}

/**
 * Deliver the one answer pi gets for `id`. False when the slot was already taken (another surface won the
 * race, or VS Code answered it natively).
 */
export function answerUiRequest(
  id: string,
  response: ExtensionUiResponse,
): boolean {
  const entry = pending.get(id);
  if (!entry || entry.answered) return false;
  entry.answered = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  pending.delete(id);
  entry.deps.respond(response);
  entry.deps.dismiss(id);
  return true;
}

/** Stop tracking an id that is finished with (diagnostics and tests). */
export function releaseUiRequest(id: string): void {
  const entry = pending.get(id);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(id);
}

/** Requests still awaiting an answer (diagnostics and tests). */
export function pendingUiRequestCount(): number {
  return pending.size;
}

/**
 * Make room for a new request. The evicted one is still unanswered, so it goes to the native dialog rather
 * than being dropped — pi would otherwise stay parked behind a question this module forgot about.
 */
function evictOldest(): void {
  const oldest = pending.keys().next();
  if (oldest.done) return;
  const entry = pending.get(oldest.value);
  pending.delete(oldest.value);
  // A dialog a surface already painted is left alone: it can still be answered in the webview, and
  // popping a second question over it would be worse than forgetting the id.
  if (!entry || entry.acked || entry.answered) return;
  void takeOverNatively(oldest.value, entry, 'evicted');
}

/** Take over natively, unless a visible surface already showed the dialog or it has been answered. */
async function runNativeFallback(id: string, reason: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry || entry.acked || entry.answered) return;
  pending.delete(id);
  await takeOverNatively(id, entry, reason);
}

async function takeOverNatively(
  id: string,
  entry: PendingDialog,
  reason: string,
): Promise<void> {
  // Take the answer slot before awaiting: a webview click that lands while the native dialog is open
  // must not answer pi twice.
  entry.answered = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  entry.deps.log(
    `[ui] ${entry.request.method} ${id}: ${reason} ` +
      `(posted to ${entry.surfaces} surface(s)) → native dialog`,
  );
  entry.deps.dismiss(id);
  try {
    const response = await entry.deps.fallbackToNative(entry.request);
    if (response) entry.deps.respond(response);
  } catch (err) {
    // A failed native dialog must not leave the tool call parked: no answer is a deny for pi-gate anyway,
    // but sending one frees the runtime and makes the failure visible in the log.
    const text = err instanceof Error ? err.message : String(err);
    entry.deps.log(`[ui] ${id}: native dialog failed: ${text}`);
    entry.deps.respond({ type: 'extension_ui_response', id, cancelled: true });
  }
}
