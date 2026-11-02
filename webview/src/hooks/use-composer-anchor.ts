import { useEffect, useState } from 'react';

/**
 * Where a composer popup should float: the rect of the `.input-bar` the textarea sits in.
 * Extracted because the command menu and the file menu both escape an `overflow:hidden`
 * ancestor the same way — a portal plus fixed positioning measured off the composer — and
 * one of them drifting would look broken.
 *
 * Refreshed on scroll, on window resize, and whenever the composer itself changes height:
 * the textarea grows upward as the draft wraps, which moves the anchor with no window event
 * at all. Returns null until the textarea exists, so callers render nothing until they are
 * positioned for real.
 */
export function useComposerAnchor(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const composer = textarea.closest('.input-bar');
    if (!composer) return;

    const update = () => setRect(composer.getBoundingClientRect());
    update();

    const observer = new ResizeObserver(update);
    observer.observe(composer);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [textareaRef]);

  return rect;
}

/**
 * Stack a popup above the composer, `gap` clear of it. `viewportHeight` is a parameter
 * rather than a `window` read so the arithmetic stays unit-testable in a node environment.
 */
export function popoverStyle(
  rect: Pick<DOMRect, 'left' | 'width' | 'top'>,
  viewportHeight: number,
  gap = 8,
): React.CSSProperties {
  return {
    position: 'fixed',
    left: rect.left,
    width: rect.width,
    bottom: viewportHeight - rect.top + gap,
  };
}
