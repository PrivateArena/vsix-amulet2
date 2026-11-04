/**
 * How pi recognises a slash-command invocation in message text.
 *
 * The RPC protocol has no "run command" call: a command runs because the message
 * *starts* with `/name` and pi's prompt path matches it against the registered
 * extension commands (`_tryExecuteExtensionCommand` in pi's `dist/core/agent-session.js`).
 * A client that guesses a looser rule sends the text to the model instead, so this
 * mirrors pi exactly, quirks included:
 *
 * - anchored at offset 0, no trimming (a leading space is an ordinary message);
 * - the name ends at the **first literal space** — tabs and newlines are name characters;
 * - comparison is case-sensitive against the name pi reports (`invocationName`).
 */

export interface CommandInvocation {
  /** Command name without its leading slash, as pi compares it. */
  name: string;
  /** Everything after the first space, verbatim (pi passes it to the handler untouched). */
  args: string;
}

/**
 * The invocation `text` would be matched as, or null when pi would treat the text as
 * an ordinary prompt. `//` and a bare `/` name nothing, so they are not invocations.
 */
export function parseCommandInvocation(text: string): CommandInvocation | null {
  if (!text.startsWith('/') || text.length < 2) return null;
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(1) : text.slice(1, space);
  if (!name) return null;
  return { name, args: space === -1 ? '' : text.slice(space + 1) };
}
