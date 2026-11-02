/**
 * Quoting a passage of the transcript into the composer.
 *
 * A quote has to survive being pasted into a textarea the user is already typing in:
 * the block keeps its own line structure, and the draft it lands in is never eaten.
 */

/** Prefix every line of `text` so it reads as a blockquote. */
export function toBlockquote(text: string): string {
  const body = text.replace(/\s+$/, '');
  if (!body) return '';
  return body
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Add a finished block to the current draft, leaving what the user typed alone and
 * parking the caret on a fresh line under the quote.
 */
export function appendToDraft(draft: string, block: string): string {
  const body = block.replace(/\s+$/, '');
  if (!body) return draft;
  const head = draft.replace(/\s+$/, '');
  if (!head.trim()) return `${body}\n`;
  return `${head}\n\n${body}\n`;
}
