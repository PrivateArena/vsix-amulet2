import { memo } from 'react';
import { useStickToBottom } from '../../../hooks/use-stick-to-bottom';
import { buildStreamTail } from '../stream-tail';
import './command-stream.scss';

/**
 * Rows in the window: twelve lines of the card's code line-height is about what the box the card
 * gives a streaming body holds, so the window is the view rather than something scrolled inside
 * it — the fold then appears exactly when the head really has left the screen.
 */
const COMMAND_TAIL_LINES = 12;

export interface CommandStreamProps {
  /** The command as far as the model has typed it. */
  command: string;
}

/**
 * The command of a `bash` card while the model is still typing it.
 *
 * A terminal call is where a heredoc goes, so this argument is often a whole file — hundreds of
 * lines, arriving a few characters at a time, and the interesting part of it is the end. The card
 * therefore shows what a streaming `write` shows: a sliding window over the tail of the text,
 * followed as it grows, and rendered as rows rather than as one growing block of text so that the
 * work per frame stays the size of the window instead of the size of the file.
 *
 * The `$` prompt marks the first line while that line is still on screen; once the window has cut
 * it, the fold says so and the rows are just the body. When the command is typed the card goes
 * back to reading from its head, and what moves is the output — followed by the card itself.
 *
 * Memoized: the transcript re-renders on every streamed token, and cutting a fresh window out of
 * the command is work for the text, not for the card.
 */
export const CommandStream = memo(function CommandStream({
  command,
}: CommandStreamProps) {
  const tail = buildStreamTail(command, COMMAND_TAIL_LINES);
  // Follow the body while it types in, and hand the scroll back the moment the reader looks at an
  // earlier part of it. The revision counts characters, not rendered rows: a long line grows below
  // the fold too, and the caret must not leave the screen.
  const stick = useStickToBottom<HTMLDivElement>(command.length);
  const rows = tail.lines.length ? tail.lines : [''];
  const lastIndex = rows.length - 1;

  return (
    <div className="exec-cmd-stream" ref={stick.ref} onScroll={stick.onScroll}>
      {tail.skipped > 0 && (
        <div className="exec-stream-fold">
          {`… ${tail.skipped} earlier ${tail.skipped === 1 ? 'line' : 'lines'} …`}
        </div>
      )}
      {rows.map((line, i) => (
        /*
         * Keyed by the visible row, not by the line's number in the command: the window slides
         * rows off the top as others arrive below, and numbering the rows then re-keys every one
         * of them — the whole body torn down and rebuilt to change a window full of text, and
         * the box's horizontal position, where the reader left the long lines, with it.
         */
        <div key={i} className="exec-cmd-line">
          {tail.skipped === 0 ? `$ ${line}` : line}
          {i === lastIndex && <span className="exec-stream-caret" aria-hidden />}
        </div>
      ))}
    </div>
  );
});
