/**
 * What Amulet asks the human to look at, and how loudly.
 *
 * Nothing here imports `vscode`. The service hands in the facts only it owns (window focus, the settings)
 * and this module turns them into one payload shape that both delivery channels — VS Code's own
 * notification and the operating system's notification centre — render, plus the two rules that decide
 * whether a payload has to leave the workbench at all.
 */

/** One attention request: a heading, one body line, and whether the run is parked behind it. */
export interface AttentionMessage {
  title: string;
  body: string;
  /**
   * True while the runtime is blocked on a human answer. The OS channel gives such a message its own
   * expiry and, if `amulet.notifySticky` is on, the `critical` tier — see `toSystemNotification` in
   * `system-channel.ts`, which explains why those two are alternatives rather than a pair.
   */
  critical: boolean;
}

/** Cap for a notification body: a report lead-in, not the report. */
export const MAX_BODY_CHARS = 240;

/** Cap for the toast line, which VS Code folds aggressively. */
export const MAX_TOAST_CHARS = 180;

/** Collapse a wire body (multi-line titles, whole reports) into one capped notification line. */
export function summarize(text: string, limit = MAX_BODY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * What a dialog is actually asking about, for the one part of the alert every server shows in full: the
 * quoted subject (pi-gate quotes the command it wants a decision on), with the extension's own prefix
 * removed. `undefined` when the heading quotes nothing, where the whole heading has to do.
 */
export function quotedSubject(heading: string): string | undefined {
  const quoted = /`([^`]+)`/.exec(heading)?.[1]?.trim();
  return quoted ? quoted : undefined;
}

/** The same message as one VS Code toast line, with the body out of the title. */
export function toastText(
  message: AttentionMessage,
  limit = MAX_TOAST_CHARS,
): string {
  const body =
    message.body && !message.title.includes(message.body)
      ? ` — ${message.body}`
      : '';
  return summarize(`${message.title}${body}`, limit);
}

/**
 * Whether the operating system's notification centre should fire in addition to the toast.
 *
 * A toast is visible inside the workbench and nowhere else, so a focused window means the human can
 * already see the answer — reaching outside VS Code is only worth it while they are somewhere else.
 */
export function needsSystemNotification(o: {
  enabled: boolean;
  windowFocused: boolean;
}): boolean {
  return o.enabled && !o.windowFocused;
}

/**
 * Status-bar text while dialogs sit unanswered, or `null` when nothing is pending. The status bar is the
 * durable half of the approval alert: a notification — toast or system — expires, an unanswered dialog
 * does not.
 */
export function approvalStatusLabel(open: number): string | null {
  if (open <= 0) return null;
  return open === 1
    ? '$(warning) Amulet: approval waiting'
    : `$(warning) Amulet: ${open} approvals waiting`;
}

/** Folder name of a runtime's cwd, for telling two workspace folders apart in one title. */
export function projectLabel(cwd: string): string {
  // Split on either separator rather than through `node:path`: the label is cosmetic, and a test (or a
  // remote session) must not depend on which separator the host platform happens to honour.
  const parts = cwd.split(/[/\\]+/).filter(Boolean);
  const name = parts[parts.length - 1];
  return name && name !== '.' ? name : 'chat';
}
