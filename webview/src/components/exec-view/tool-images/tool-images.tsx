import { memo, useEffect } from 'react';
import { LuImage, LuMaximize2, LuTriangleAlert } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import type { ToolImageRef } from '../../../../../shared/protocol';
import { formatByteSize } from '../../../utils/format';
import { basename } from '../tool-display';
import './tool-images.scss';

export interface ToolImagesProps {
  /** Owning call, so the host can answer into the right card. */
  toolCallId: string;
  images: ToolImageRef[];
  /**
   * Whether the card is open. The bytes are requested on the strength of this flag alone:
   * a collapsed card asks the host for nothing at all.
   */
  expanded: boolean;
}

/**
 * The images a tool returned, read from disk on demand.
 *
 * pi hands a screenshot back as base64 in the tool result; the host strips that payload
 * off the wire and keeps only the reference, so the transcript carries no image bytes
 * until a reader opens the card that shows one. Memoized because the transcript re-renders
 * on every streamed token.
 */
export const ToolImages = memo(function ToolImages({
  toolCallId,
  images,
  expanded,
}: ToolImagesProps) {
  return (
    <div className="exec-images">
      {images.map((image, index) => (
        <ToolImage
          key={`${image.path ?? ''}#${index}`}
          toolCallId={toolCallId}
          index={index}
          image={image}
          expanded={expanded}
        />
      ))}
    </div>
  );
});

interface ToolImageProps {
  toolCallId: string;
  /** Position in the call's result: two tiles may name the same file. */
  index: number;
  image: ToolImageRef;
  expanded: boolean;
}

function sizeOf(image: ToolImageRef): string {
  // Prefer what was actually read; the reference's own figure is the size the runtime
  // reported, which is what it may have resized down to.
  const bytes = image.size ?? image.bytes;
  return bytes > 0 ? formatByteSize(bytes) : '';
}

/**
 * The whole lazy rule in one place: a card asks the host for pixels it does not have,
 * and only while the reader has it open. A collapsed card — which is every settled tool
 * card by default — fetches nothing.
 *
 * Deliberately stateless about *having* asked: state is the only honest record, since the
 * reducer may retire a data URL the reader stopped looking at, and a card that remembered
 * its own requests would then show a wait that never ends.
 */
export function needsToolImage(
  image: ToolImageRef,
  expanded: boolean,
): boolean {
  return expanded && !!image.path && !image.dataUrl && !image.error;
}

function ToolImage({ toolCallId, index, image, expanded }: ToolImageProps) {
  const { path, mimeType, dataUrl, error } = image;
  const label = path ? basename(path) : mimeType;

  useEffect(() => {
    if (path && needsToolImage(image, expanded)) {
      actions.loadToolImage(toolCallId, index, path);
    }
  }, [image, expanded, index, path, toolCallId]);

  const size = sizeOf(image);

  if (error) {
    return (
      <div className="exec-image-state is-error" title={path ?? undefined}>
        <LuTriangleAlert className="exec-image-state-icon" aria-hidden />
        <span className="exec-image-state-text">{error}</span>
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div className="exec-image-state" title={path ?? undefined}>
        <LuImage className="exec-image-state-icon" aria-hidden />
        <span className="exec-image-state-text">
          {label}
          {size ? ` · ${size}` : ''}
          {/* A collapsed card is mounted but invisible, and it has asked the host for
              nothing — say so rather than promising a load that is not in flight. */}
          {path
            ? expanded
              ? ' · loading…'
              : ' · not loaded'
            : ' · no file to read'}
        </span>
      </div>
    );
  }

  return (
    <figure className="exec-image">
      <div className="exec-image-frame" title={path ?? label}>
        <img
          src={dataUrl}
          alt={label}
          className="exec-image-img"
          loading="lazy"
        />
        {path && (
          <button
            type="button"
            className="exec-image-zoom"
            aria-label={`Open ${label} in the editor`}
            onClick={() => actions.openToolImage(toolCallId, path)}>
            <LuMaximize2 aria-hidden />
          </button>
        )}
      </div>
      <figcaption className="exec-image-caption">
        <span className="exec-image-name" title={path ?? undefined}>
          {label}
        </span>
        <span className="exec-image-meta">
          {[size, mimeType].filter(Boolean).join(' · ')}
        </span>
      </figcaption>
    </figure>
  );
}
