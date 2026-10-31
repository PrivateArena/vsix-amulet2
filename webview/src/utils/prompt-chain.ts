/**
 * Chained slash prompts.
 *
 * The pi runtime expands at most ONE prompt template per message, and only when
 * the message *starts* with `/name` (`expandPromptTemplate` is anchored at `^`),
 * so `/architect "plan X" /maintainer "fix Y"` would hand `/maintainer "fix Y"`
 * to `/architect` as arguments. Splitting the composer text at the command
 * boundaries lets the host send each part as its own queued prompt, where every
 * part expands independently.
 */

/** Predicate over command names (without the leading slash). */
export type CommandNameMatcher = (name: string) => boolean;

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * Offsets of the `/name` tokens the runtime treats as commands. Tokens inside a
 * quoted span never split (so `/a "review /b"` stays one prompt), and a repeat of
 * the name that already opened the current part is an argument, not a new link
 * (`/architect compare /architect v2` stays one prompt).
 */
function findCommandStarts(
  text: string,
  isCommand: CommandNameMatcher,
): number[] {
  const starts: number[] = [];
  let partName: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    // Quotes open a span only where an argument would start; an apostrophe inside
    // `don't` is literal text and must not swallow the rest of the message.
    const atTokenStart = i === 0 || isSpace(text[i - 1]!);
    if (ch === '"' || ch === "'") {
      if (atTokenStart) quote = ch;
      continue;
    }
    if (ch !== '/' || !atTokenStart) continue;
    const name = /^[^\s"']+/.exec(text.slice(i + 1))?.[0];
    if (!name || name === partName || !isCommand(name)) continue;
    partName = name;
    starts.push(i);
  }
  return starts;
}

/**
 * Split `text` into the prompts of one chain. Returns a single-entry array when
 * there is nothing to split — including when the message does not start with a
 * known command, because the runtime would not expand anything then either.
 */
export function splitPromptChain(
  text: string,
  isCommand: CommandNameMatcher,
): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return [trimmed];
  const starts = findCommandStarts(trimmed, isCommand);
  if (starts.length < 2 || starts[0] !== 0) return [trimmed];
  return starts.map((start, i) =>
    trimmed.slice(start, starts[i + 1] ?? trimmed.length).trim(),
  );
}
