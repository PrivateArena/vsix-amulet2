import { memo } from 'react';
import { useStickToBottom } from '../../../hooks/use-stick-to-bottom';
import { buildWritePreview } from './write-preview';
import './write-stream.scss';

export interface WriteStreamProps {
  /** The file body as far as it has streamed. */
  content: string;
  /** True while the model is still producing the call, i.e. the body can still grow. */
  streaming: boolean;
}

/**
 * The body of a `write` card while the call is in flight.
 *
 * pi does not stream a write's *execution* — the tool reports nothing until the file is on
 * disk — so everything a card can show live comes from the call's streamed arguments. This
 * surface renders those arguments as the additions-only diff the finished card will show, so
 * the file reads as one continuous write from the first token to the last.
 *
 * Memoized: the transcript re-renders on every streamed token, and cutting a fresh preview
 * out of the whole body is work for the content, not for the card.
 */
export const WriteStream = memo(function WriteStream({
  content,
  streaming,
}: WriteStreamProps) {
  const preview = buildWritePreview(content);
  // Follow the body while it streams, and hand the scroll back the moment the reader looks
  // at an earlier part of the file. The revision is the character count, not the line count:
  // a long line grows below the fold too, and the caret must not leave the screen.
  const stick = useStickToBottom<HTMLDivElement>(content.length, streaming);
  const lastIndex = preview.lines.length - 1;

  return (
    <div
      className="exec-write-stream exec-write-highlight"
      ref={stick.ref}
      onScroll={stick.onScroll}>
      {preview.skipped > 0 && (
        <div className="exec-write-fold">
          {`… ${preview.skipped} earlier ${preview.skipped === 1 ? 'line' : 'lines'} …`}
        </div>
      )}
      {preview.lines.map((line, i) => (
        <div
          key={preview.skipped + i}
          className="patch-line patch-line-add exec-write-line">
          {`+ ${line}`}
          {streaming && i === lastIndex && (
            <span className="exec-write-caret" aria-hidden />
          )}
        </div>
      ))}
      {preview.totalLines === 0 && (
        <div className="exec-write-empty">
          {streaming ? 'Writing content…' : 'Empty file'}
          {streaming && <span className="exec-write-caret" aria-hidden />}
        </div>
      )}
    </div>
  );
});
