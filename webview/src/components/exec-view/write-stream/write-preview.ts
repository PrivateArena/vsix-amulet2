/**
 * The body of a `write` call, prepared for live display.
 *
 * Pure so the windowing rules are testable without a DOM, and so a card can derive the
 * same figures for its header badge and its body — from the streamed arguments, which are
 * the only thing pi offers while a write is in flight.
 */

/**
 * Lines kept in the live preview. A file body streams in a few characters at a time and the
 * newest line is the interesting part, so the preview is a sliding tail window: bounded work
 * and bounded DOM per frame, whatever the size of the file.
 */
export const WRITE_PREVIEW_LINES = 24;

export interface WritePreview {
  /** Tail window of the streamed body, oldest line first. */
  lines: string[];
  /** Lines above the window, i.e. how many the window cut. */
  skipped: number;
  /** Lines in the whole body. */
  totalLines: number;
}

/**
 * Turn streamed (possibly partial) file content into the lines a card shows.
 *
 * A trailing line ending terminates the last line instead of adding an empty one — that is
 * how a diff counts the same file, and while the body still streams it keeps the caret off
 * a blank row.
 */
export function buildWritePreview(
  content: string | undefined,
  maxLines = WRITE_PREVIEW_LINES,
): WritePreview {
  const body = trimEnding(content);
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

/**
 * Drop the line ending that merely terminates the last line — one of them, so a blank line
 * a file really ends with stays a line.
 */
function trimEnding(content: string | undefined): string {
  if (!content) return '';
  let end = content.length;
  if (content.endsWith('\n')) {
    end--;
    if (content[end - 1] === '\r') end--; // a CRLF terminated the last line
  } else if (content[end - 1] === '\r') {
    end--; // a lone CR: an old-Mac ending, or a CRLF whose `\n` has not streamed
  }
  return content.slice(0, end);
}

function split(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

/** Line count of the body, without materializing its lines. */
function countLines(body: string): number {
  if (!body) return 0;
  let lines = 1;
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lines++;
  return lines;
}

/**
 * The `+N lines` figure in a write card's header. It is the one number that moves while
 * the model types the body, and it goes on describing the file once the call has settled.
 */
export function writeLineBadge(content: string | undefined): string {
  const lines = countLines(trimEnding(content));
  if (lines === 0) return '';
  return `+${lines} ${lines === 1 ? 'line' : 'lines'}`;
}
