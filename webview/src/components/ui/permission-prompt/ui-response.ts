/**
 * Pure half of the permission prompt: turn a raw pi `extension_ui_request` into something renderable,
 * and the human's answer into the exact `extension_ui_response` the runtime parses.
 *
 * The response shape is fixed by pi's RPC front-end (dist/modes/rpc/rpc-mode.js): `select`/`input`/
 * `editor` read `value`, `confirm` reads `confirmed`, and anything with `cancelled: true` resolves to
 * "no answer" — which pi-gate maps to an abort. Keeping the mapping here (instead of inline in the
 * component) is what lets `ui-response.test.ts` pin that contract without a DOM.
 */

import {
  type ExtensionUiRequest,
  type ExtensionUiResponse,
} from '../../../../../shared/protocol';

/** The human's pick, before it is shaped into a wire response. */
export type UiAnswer =
  | { kind: 'value'; value: unknown }
  | { kind: 'confirmed'; confirmed: boolean }
  | { kind: 'cancelled' };

export interface UiOption {
  label: string;
  value: unknown;
}

/** Title fallbacks, so a dialog without one is still self-describing. */
const FALLBACK_TITLES: Record<string, string> = {
  select: 'Choose an option',
  confirm: 'Please confirm',
  input: 'Enter a value',
  editor: 'Edit the text',
};

export function dialogTitle(req: ExtensionUiRequest): string {
  const title = typeof req.title === 'string' ? req.title.trim() : '';
  return title || FALLBACK_TITLES[req.method] || 'Extension request';
}

/** Body text for `confirm` (its question is separate from its title). */
export function dialogMessage(req: ExtensionUiRequest): string {
  return typeof req.message === 'string' ? req.message : '';
}

/** Placeholder for `input`, initial text for `editor`. */
export function dialogDraft(req: ExtensionUiRequest): string {
  if (req.method === 'editor') {
    return typeof req.prefill === 'string' ? req.prefill : '';
  }
  return typeof req.placeholder === 'string' ? req.placeholder : '';
}

/** Normalize `select` options: pi extensions pass plain strings, component UIs may pass objects. */
export function dialogOptions(req: ExtensionUiRequest): UiOption[] {
  const raw = Array.isArray(req.options) ? (req.options as unknown[]) : [];
  return raw.map((opt) => {
    if (typeof opt === 'string') return { label: opt, value: opt };
    if (opt && typeof opt === 'object') {
      const o = opt as Record<string, unknown>;
      const label = String(o.label ?? o.title ?? o.name ?? o.value ?? '');
      return { label, value: 'value' in o ? o.value : label };
    }
    const label = String(opt);
    return { label, value: opt };
  });
}

export function buildUiResponse(
  req: Pick<ExtensionUiRequest, 'id' | 'method'>,
  answer: UiAnswer,
): ExtensionUiResponse {
  const base = { type: 'extension_ui_response' as const, id: req.id };
  if (answer.kind === 'cancelled') return { ...base, cancelled: true };
  if (answer.kind === 'confirmed') {
    return { ...base, confirmed: answer.confirmed };
  }
  return { ...base, value: answer.value };
}
