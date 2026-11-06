import * as vscode from 'vscode';
import { parseBridgeReply } from '../../shared/bridge-protocol';
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
} from '../../shared/protocol';
import type { Logger } from '../runtime/pi-runtime';

/** Whether this notify text is an Amulet bridge ack (any bridge's, not necessarily this one's). */
export function isBridgeAck(message: string): boolean {
  return parseBridgeReply(message) !== null;
}

/**
 * Map a pi `extension_ui_request` (dialogs/notifications emitted by pi extensions,
 * e.g. tool-approval prompts) to native VS Code UI, and produce the response the
 * runtime expects. Fire-and-forget methods return `null` (no response needed).
 *
 * `tryBridgeReply` is the one interception point for the Amulet bridge (`pi-bridge/`,
 * `src/webview/bridge-client.ts`): the bridge answers its operations with a `notify`, because an
 * extension command has no other output channel, and that machine-readable ack must be handed to the
 * client that is waiting for it instead of being toasted. It is asked first and for every notify, so a
 * reply nobody claims still takes the normal path — and every other extension's notify is untouched.
 */
export async function handleExtensionUiRequest(
  req: ExtensionUiRequest,
  _log: Logger,
  tryBridgeReply?: (message: string) => boolean | Promise<boolean>,
): Promise<ExtensionUiResponse | null> {
  const respond = (
    extra: Partial<ExtensionUiResponse>,
  ): ExtensionUiResponse => ({
    type: 'extension_ui_response',
    id: req.id,
    ...extra,
  });

  switch (req.method) {
    case 'confirm': {
      const title = String(req.title ?? 'Confirm');
      const message = req.message ? String(req.message) : undefined;
      const pick = await vscode.window.showInformationMessage(
        title,
        { modal: true, detail: message },
        'Yes',
        'No',
      );
      if (pick === undefined) return respond({ cancelled: true });
      return respond({ confirmed: pick === 'Yes' });
    }
    case 'select': {
      const title = String(req.title ?? 'Select');
      const rawOptions = Array.isArray(req.options)
        ? (req.options as unknown[])
        : [];
      const items = rawOptions.map((opt) => normalizeOption(opt));
      const picked = await vscode.window.showQuickPick(
        items.map((i) => i.label),
        { title, placeHolder: title },
      );
      if (picked === undefined) return respond({ cancelled: true });
      const match = items.find((i) => i.label === picked);
      return respond({ value: match ? match.value : picked });
    }
    case 'input': {
      const title = String(req.title ?? 'Input');
      const value = await vscode.window.showInputBox({
        title,
        placeHolder: req.placeholder ? String(req.placeholder) : undefined,
      });
      if (value === undefined) return respond({ cancelled: true });
      return respond({ value });
    }
    case 'editor': {
      const title = String(req.title ?? 'Edit');
      const value = await vscode.window.showInputBox({
        title,
        value: req.prefill ? String(req.prefill) : undefined,
        prompt: title,
      });
      if (value === undefined) return respond({ cancelled: true });
      return respond({ value });
    }
    case 'notify': {
      const message = String(req.message ?? '');
      // Consumed by the bridge: the caller that issued the operation has its answer, and the human
      // never asked to see the wire text of it.
      if (await tryBridgeReply?.(message)) return null;
      // …and an ack answered by another surface is still Amulet's own traffic. Every live surface sees
      // every notify (dialog routing cannot rely on `visible`), so the copies this bridge did not issue
      // come back as text it does not own — which must never become a toast either.
      if (isBridgeAck(message)) return null;
      const kind = String(req.notifyType ?? 'info');
      if (kind === 'error') void vscode.window.showErrorMessage(message);
      else if (kind === 'warn' || kind === 'warning')
        void vscode.window.showWarningMessage(message);
      else void vscode.window.showInformationMessage(message);
      return null;
    }
    default:
      // setStatus / setTitle / setWidget / set_editor_text: no native mapping yet.
      // pi extensions emit these in a tight loop (status updates, widget
      // ticks); logging each one floods the output channel and stalls the
      // webview. Silently ignore — there is nothing actionable here.
      return null;
  }
}

function normalizeOption(opt: unknown): { label: string; value: unknown } {
  if (typeof opt === 'string') return { label: opt, value: opt };
  if (opt && typeof opt === 'object') {
    const o = opt as Record<string, unknown>;
    const label = String(o.label ?? o.title ?? o.name ?? o.value ?? '');
    return { label, value: 'value' in o ? o.value : label };
  }
  return { label: String(opt), value: opt };
}
