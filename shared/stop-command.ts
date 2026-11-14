/**
 * The contract of stopping one running command.
 *
 * pi gives a client exactly one cancellation: `abort`, which aborts the *run's* signal and therefore the turn.
 * Amulet's Stop button has always been that. Stopping one command instead — the 50-minute `pnpm build` that ate
 * a subagent's whole time budget — is done by signalling the process pi spawned for that call, which needs no
 * pi API and ends nothing but the command: pi reports the call as a failed result (`Command exited with code
 * 137`) and the loop continues.
 *
 * Which is why the wording here is the other half of the feature: a bare `137` reads to the model as a crash
 * and invites the same command again, so the human's own words ride at the head of that result. Both sides
 * need the same sentences — the bridge injects them, the dialog previews what will be injected — and a
 * constant in one file is the only way they cannot drift.
 *
 * Lives in `shared/` because both the host bundle and the webview bundle read it, and neither may import
 * `pi-bridge/` (that half touches `node:child_process`).
 */

/** pi's shell tools: the calls that put a real OS process on the machine. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'powershell'];

/**
 * Whether this call has a process to stop.
 *
 * Every other pi tool runs in-process — a hung `grep` is a hung regexp, and no signal reaches it. One list for
 * the bridge (which records only stoppable calls) and the transcript (which must not offer a button that can
 * only ever refuse).
 */
export function isShellTool(toolName: string | undefined): boolean {
  return !!toolName && SHELL_TOOLS.includes(toolName);
}

/**
 * The command a shell call will run, from pi's own argument object.
 *
 * `undefined` is what a call with no stoppable process looks like from either side: not a shell, or no
 * command text yet, or only whitespace where one belongs.
 */
export function shellCommandOf(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (!isShellTool(toolName)) return undefined;
  const command = (args as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' && command.trim() ? command : undefined;
}

/** pi-gate's shape, kept verbatim so one vocabulary covers both extensions. */
export const STOP_NOTE_PREFIX = 'Stopped by user';

/**
 * A note is a sentence, not a report, and it is about to be pasted at the head of a tool result the model
 * re-reads on every later request. Long input is clamped rather than refused, because the alternative to a
 * truncated reason is no reason at all — and unlike `replace`, whose content is a tool output the human is
 * editing, this text has no fidelity requirement beyond being what they meant.
 */
export const STOP_NOTE_LIMIT_CHARS = 2_000;

export function clampStopNote(text: string): string {
  const note = text.trim();
  if (note.length <= STOP_NOTE_LIMIT_CHARS) return note;
  return `${note.slice(0, STOP_NOTE_LIMIT_CHARS)} […]`;
}

/**
 * The sentence the model reads at the head of a stopped call's result.
 *
 * Factual, with no instruction attached: pi-gate writes its block reasons the same way — *"an instruction not
 * to retry reads as a challenge to a determined agent"* (`pi-gate/prompt.ts`). What the model needs is to know
 * a human ended that call, which is also the only honest account of a result with no exit code.
 */
export function stopNoteText(note?: string): string {
  return note
    ? `${STOP_NOTE_PREFIX} with note: ${note}`
    : `${STOP_NOTE_PREFIX}: the command was terminated before it finished.`;
}
