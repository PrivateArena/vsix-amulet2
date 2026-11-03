/**
 * Turning a pending pi dialog into something worth interrupting a human for.
 *
 * Nothing here imports `vscode`. A modal `extension_ui_request` parks the tool call until somebody answers
 * it (see `src/webview/ui-request-routing.ts`), which makes it the second thing worth leaving the editor
 * for. The two that matter in practice are pi-gate's approval prompt and pi-subagent's turn/time budget
 * extension, and both are plain `select` dialogs whose `title` names the extension that raised it — so the
 * prefix is used only to *label* the alert, while every modal method is treated as waiting-for-a-human. A
 * dialog from an extension nobody has met yet therefore still notifies.
 */

import type { ExtensionUiRequest } from '../../shared/protocol';
import { isModalUiMethod } from '../webview/ui-request-routing';
import { quotedSubject, summarize, type AttentionMessage } from './attention';

/** Which question is waiting, in the words the alert uses. */
export type ApprovalKind = 'approval' | 'budget' | 'question';

export interface ApprovalPrompt {
  kind: ApprovalKind;
  /** The dialog's own first line, e.g. ``pi-gate: bash — `git push` [floor: protected_path]``. */
  heading: string;
  /**
   * How long the *extension* waits before answering itself, when it does at all. Past that the question
   * is dead on the runtime side even though the dialog is still on screen, so the alert expires with it.
   */
  timeoutMs?: number;
}

const GATE_PREFIX = 'pi-gate:';
const SUBAGENT_PREFIX = 'pi-subagent:';

/**
 * Describe a request that needs a human, or `null` for the fire-and-forget methods (`notify`, `setStatus`,
 * `setWidget`, …) that block nothing and must never notify — a pi extension emits those in a tight loop.
 * The bridge already routes only modal methods to the dialog registry; the guard here keeps this module
 * correct on its own, whatever a caller hands it.
 */
export function describeApprovalRequest(
  req: ExtensionUiRequest,
): ApprovalPrompt | null {
  if (!isModalUiMethod(req.method)) return null;
  const title = typeof req.title === 'string' ? req.title : '';
  const heading = firstLine(title) || fallbackHeading(req);
  const kind: ApprovalKind = heading.startsWith(GATE_PREFIX)
    ? 'approval'
    : heading.startsWith(SUBAGENT_PREFIX)
      ? 'budget'
      : 'question';
  return { kind, heading: summarize(heading), timeoutMs: timeoutOf(req) };
}

/** The question, in the words the alert uses. */
const KIND_LABEL: Record<ApprovalKind, string> = {
  approval: 'Approval needed',
  budget: 'Subagent needs more budget',
  question: 'Answer needed',
};

/**
 * The notification for a dialog that is waiting for an answer.
 *
 * The subject leads the title because notification servers clip the body — some to a fraction of it — and a
 * truncated approval prompt is worse than a long one: the command being approved has to be readable.
 */
export function describeApprovalPrompt(
  prompt: ApprovalPrompt,
  project: string,
): AttentionMessage {
  const label = KIND_LABEL[prompt.kind];
  const subject = quotedSubject(prompt.heading);
  return {
    title: subject ? `${label}: ${subject}` : label,
    body: `${project} · ${prompt.heading}`,
    critical: true,
  };
}

/** The title without its detail lines — the first line is the question, the rest is context. */
function firstLine(title: string): string {
  for (const line of title.split('\n')) {
    if (line.trim()) return line.trim();
  }
  return '';
}

/** `confirm` puts its text in `message`, `input` in `placeholder`; a titleless dialog says what it is. */
function fallbackHeading(req: ExtensionUiRequest): string {
  for (const key of ['message', 'placeholder', 'prefill']) {
    const value = req[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return `pi is asking for ${req.method}`;
}

/** A positive `timeout` on the wire (absent means the extension waits for a human forever). */
function timeoutOf(req: ExtensionUiRequest): number | undefined {
  const value = req.timeout;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
