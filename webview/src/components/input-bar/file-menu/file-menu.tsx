import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LuCornerDownLeft, LuFile, LuFolder } from 'react-icons/lu';
import type { FileMention } from '../../../utils/at-mention';
import { normalizeMentionQuery } from '../../../utils/at-mention';
import { fuzzyHighlight } from '../../../utils/fuzzy-highlight';
import {
  popoverStyle,
  useComposerAnchor,
} from '../../../hooks/use-composer-anchor';
import './file-menu.scss';

interface FileMenuProps {
  items: FileMention[];
  /** Path typed so far; only its last segment can highlight a name. */
  query: string;
  focused: number;
  /** Directory the listing describes — the scope of every path shown here. */
  cwd: string;
  /** Row shown instead of the list: scanning, a failed scan, or nothing matched. */
  note?: string;
  /** Right-aligned footer text: how much of the tree this listing really is. */
  hint?: string;
  onHover: (index: number) => void;
  onSelect: (mention: FileMention) => void;
  /** Ref to the textarea element for positioning. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * The floating file palette shown above the composer while an `@token` is being typed.
 * Presentational, like the command menu: parsing, ranking and the host round trip live in
 * `useFileMentions`.
 *
 * Paths render monospaced with the directory dimmed behind the name, because the name is
 * what the user scans for and the directory is what tells two `index.ts` files apart.
 */
export function FileMenu({
  items,
  query,
  focused,
  cwd,
  note,
  hint,
  onHover,
  onSelect,
  textareaRef,
}: FileMenuProps) {
  const composerRect = useComposerAnchor(textareaRef);
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleMouseDown = useCallback(
    (mention: FileMention) => (e: React.MouseEvent) => {
      // The textarea must keep focus, or the caret the insert relies on is gone.
      e.preventDefault();
      onSelect(mention);
    },
    [onSelect],
  );

  // The list is capped well past what fits, so the focused row has to be kept in view —
  // neither the arrow keys nor the mouse can be trusted to leave it visible.
  useEffect(() => {
    const row = listRef.current?.querySelector('[data-focused="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [focused, items.length]);

  if (!composerRect || (items.length === 0 && !note)) return null;

  const typed = normalizeMentionQuery(query);
  const nameQuery = typed.slice(typed.lastIndexOf('/') + 1);

  return createPortal(
    <div
      className="file-menu"
      role="listbox"
      aria-label="Project files"
      title={cwd}
      style={
        {
          ...popoverStyle(composerRect, window.innerHeight),
          '--amulet-popover-enter-y': '7px',
        } as React.CSSProperties
      }>
      <div className="file-menu-list" ref={listRef}>
        {note && <div className="file-menu-note">{note}</div>}
        {items.map((item, idx) => (
          <div
            key={`${item.kind}:${item.path}`}
            data-idx={idx}
            data-focused={idx === focused}
            role="option"
            aria-selected={idx === focused}
            tabIndex={-1}
            className={`file-item${idx === focused ? ' focused' : ''}`}
            onMouseDown={handleMouseDown(item)}
            onMouseEnter={() => onHover(idx)}>
            <span className={`file-item-icon is-${item.kind}`}>
              {item.kind === 'dir' ? (
                <LuFolder size={12} />
              ) : (
                <LuFile size={12} />
              )}
            </span>
            <span className="file-item-path">
              {item.dir && <span className="file-item-dir">{item.dir}/</span>}
              {fuzzyHighlight(item.name, nameQuery).nodes}
            </span>
          </div>
        ))}
      </div>
      <div className="file-menu-footer">
        <span className="file-hint">
          <kbd className="file-kbd">↑</kbd>
          <kbd className="file-kbd">↓</kbd>
          Navigate
        </span>
        <span className="file-hint">
          <kbd className="file-kbd">
            <LuCornerDownLeft size={11} />
          </kbd>
          Insert
        </span>
        <span className="file-hint file-hint-end" title={cwd}>
          {hint ?? ''}
        </span>
      </div>
    </div>,
    document.body,
  );
}
