import { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuCopy, LuGitBranch, LuQuote, LuReply } from 'react-icons/lu';
import { actions } from '../../apis/actions';
import { composer } from '../../stores/composer-store';
import { usePrivacyMode } from '../../stores/privacy-store';
import {
  copySnapshotFor,
  rawSourceOf,
  type CopyText,
} from '../../utils/md-units';
import { ContextMenuItem, useCtxMenu } from '../ui/ctx-menu';
import './transcript-menu.scss';

/** How long the "Copied" confirmation floats. */
const FLASH_MS = 1400;

export interface TranscriptMenu {
  /** `onContextMenu` handler for the transcript container. */
  open: (e: React.MouseEvent) => void;
  /** The menu and its confirmation flash — render this next to the container. */
  node: React.ReactNode;
}

interface Flash {
  x: number;
  y: number;
  label: string;
}

/**
 * Marks the block a live menu is acting on. An attribute rather than a class, so a
 * re-render of the block (a streamed delta) cannot drop it while the menu is open.
 */
const OPEN_ATTRIBUTE = 'data-ctx-open';

/**
 * The fork source for a unit: a user turn owns its block, and pi matches a fork by
 * message text, so what has to come back is the message the unit sits in.
 */
function branchTextOf(unit: HTMLElement): string | undefined {
  const owner = unit.closest<HTMLElement>('[data-branch]');
  return owner ? rawSourceOf(owner)?.trim() || undefined : undefined;
}

/**
 * The transcript's own right-click menu, in place of VS Code's.
 *
 * Everything it can do is decided at the moment of the right-click, because the
 * selection it acts on does not outlive the menu: it is snapshotted into the items
 * (see {@link copySnapshotFor}) — Copy takes text, Copy as Markdown takes the source
 * the block was rendered from, Quote and Reply hand that passage to the composer.
 */
export function useTranscriptMenu(
  listRef: RefObject<HTMLElement | null>,
): TranscriptMenu {
  const [flash, setFlash] = useState<Flash | null>(null);
  const privacyMode = usePrivacyMode();
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  const openUnit = useRef<HTMLElement | null>(null);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const showFlash = useCallback((label: string, x: number, y: number) => {
    clearTimeout(flashTimer.current);
    setFlash({ label, x, y });
    flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
  }, []);

  const buildItems = useCallback(
    (e: React.MouseEvent): ContextMenuItem[] | null => {
      const scope = listRef.current;
      if (!scope) return null;
      const snapshot = copySnapshotFor(scope, e.target);
      if (!snapshot) return null;

      const { clientX: x, clientY: y } = e;
      const target: CopyText = snapshot.selection ?? snapshot.block;
      // Text that goes back into the run — a quote, a reply, a fork — must be what the runtime said,
      // not what Privacy mode showed: a censored path here would be sent to pi as a real one. The
      // registry holds the untouched source of every block that has one, and only a partial selection
      // has none, because it never had a source of its own to begin with.
      const sourceOf = (fallback: string) =>
        rawSourceOf(snapshot.unit) ?? fallback;
      // Quote and Reply hand text back to the model, so they are offered only where the original is
      // still recoverable: a block with no registered source — a terminal `<pre>`, a patch — has
      // nothing but its censored rendering, and quoting that would ask pi about a path it never wrote.
      const quotable = !privacyMode || rawSourceOf(snapshot.unit) !== undefined;
      const copy = (text: string, label: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        actions.copyText(trimmed);
        showFlash(label, x, y);
      };
      const quote = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        composer.quote(trimmed);
        composer.focus();
      };

      const items: ContextMenuItem[] = [
        {
          label: 'Copy',
          icon: LuCopy,
          onSelect: () => copy(target.plain, 'Copied'),
        },
      ];
      // Only worth offering where markdown says more than the rendered text does.
      if (
        target.markdown.trim() &&
        target.markdown.trim() !== target.plain.trim()
      ) {
        items.push({
          label: 'Copy as Markdown',
          icon: LuCopy,
          hint: target.raw ? 'source' : undefined,
          onSelect: () => copy(target.markdown, 'Copied as Markdown'),
        });
      }
      if (quotable) {
        items.push({
          label: 'Quote',
          icon: LuQuote,
          hint: snapshot.selection ? 'selection' : 'block',
          separatorBefore: true,
          onSelect: () =>
            quote(
              snapshot.selection ? target.markdown : sourceOf(target.markdown),
            ),
        });
        items.push({
          label: 'Reply',
          icon: LuReply,
          hint: 'full block',
          onSelect: () => quote(sourceOf(snapshot.block.markdown)),
        });
      }

      const branch = branchTextOf(snapshot.unit);
      if (branch) {
        items.push({
          label: 'Branch from here',
          hint: 'edit & resend',
          icon: LuGitBranch,
          separatorBefore: true,
          onSelect: () => actions.forkFromMessage(branch),
        });
      }

      openUnit.current?.removeAttribute(OPEN_ATTRIBUTE);
      openUnit.current = snapshot.unit;
      snapshot.unit.setAttribute(OPEN_ATTRIBUTE, '');
      return items;
    },
    [listRef, showFlash, privacyMode],
  );

  const ctx = useCtxMenu(buildItems, {
    minWidth: 216,
    onClose: () => {
      openUnit.current?.removeAttribute(OPEN_ATTRIBUTE);
      openUnit.current = null;
    },
  });

  return {
    open: ctx.open,
    node: (
      <>
        {ctx.menu}
        {flash &&
          createPortal(
            <div
              className="chat-copy-flash"
              style={{ left: flash.x, top: flash.y }}
              role="status">
              {flash.label}
            </div>,
            document.body,
          )}
      </>
    ),
  };
}
