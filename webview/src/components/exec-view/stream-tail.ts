/**
 * The tail window a streaming card shows.
 *
 * A streamed argument body arrives a few characters at a time and the newest line is the
 * interesting part, so a live card renders a sliding window over the end of the text rather
 * than the whole of it: bounded work and bounded DOM per frame, whatever the size of the body.
 *
 * Each caller sizes its window to the box its card gives the stream, so the fold over the cut
 * lines appears when the head has really left the screen rather than some rows before or after
 * that, and a reader who has lost the follow is a few rows from the newest line rather than a
 * screen of them.
 *
 * Pure, so the windowing rules are testable without a DOM, and shared by every card that shows
 * text the model is still typing.
 */

/** Lines kept in the window. */
export const STREAM_TAIL_LINES = 16;

export interface StreamTail {
  /** Tail window of the streamed text, oldest line first. */
  lines: string[];
  /** Lines above the window, i.e. how many the window cut. */
  skipped: number;
  /** Lines in the whole text. */
  totalLines: number;
}

/**
 * Cut the window a card shows out of streamed (possibly partial) text.
 *
 * A trailing line ending terminates the last line instead of adding an empty one — that is how
 * a diff counts the same file, and while the body still streams it keeps the caret off a blank
 * row.
 */
export function buildStreamTail(
  text: string | undefined,
  maxLines = STREAM_TAIL_LINES,
): StreamTail {
  const body = trimEnding(text);
  const totalLines = countLines(body);
  if (totalLines === 0) return { lines: [], skipped: 0, totalLines: 0 };
  if (totalLines <= maxLines) {
    return { lines: split(body), skipped: 0, totalLines };
  }
  // Slice from the start of the line `maxLines` back, so only the visible tail is built.
  let seen = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i] !== '\n') continue;
    seen++;
    if (seen === maxLines) {
      return {
        lines: split(body.slice(i + 1)),
        skipped: totalLines - maxLines,
        totalLines,
      };
    }
  }
  return { lines: split(body), skipped: 0, totalLines };
}

/** Lines in the whole streamed text, counted without materializing them. */
export function countStreamLines(text: string | undefined): number {
  return countLines(trimEnding(text));
}

/**
 * Drop the line ending that merely terminates the last line — one of them, so a blank line
 * the text really ends with stays a line.
 */
function trimEnding(text: string | undefined): string {
  if (!text) return '';
  let end = text.length;
  if (text.endsWith('\n')) {
    end--;
    if (text[end - 1] === '\r') end--; // a CRLF terminated the last line
  } else if (text[end - 1] === '\r') {
    end--; // a lone CR: an old-Mac ending, or a CRLF whose `\n` has not streamed
  }
  return text.slice(0, end);
}

function split(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

function countLines(body: string): number {
  if (!body) return 0;
  let lines = 1;
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lines++;
  return lines;
}
