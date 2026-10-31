import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  LuCaseSensitive,
  LuChevronDown,
  LuChevronUp,
  LuRegex,
  LuX,
} from 'react-icons/lu';
import { findMatches, formatFindCount } from '../../utils/find-query';
import { IconButton } from '../ui/button';
import {
  clearHighlights,
  indexTranscript,
  matchRangeSet,
  paintHighlights,
  type TranscriptIndex,
} from './transcript-index';
import './chat-find.scss';

/** Debounce for re-indexing while the transcript streams or a block is expanded. */
const REINDEX_DELAY = 180;

export interface ChatFindProps {
  /** The scrolling transcript (`#chat-log`) to search through. */
  containerRef: RefObject<HTMLElement | null>;
  /** Reveal a match. The transcript owner scrolls — and unpins bottom-following. */
  onReveal: (ranges: Range[]) => void;
}

/** `⌘F` on macOS, `Ctrl+F` everywhere else. */
function findShortcutLabel(): string {
  const platform =
    typeof navigator === 'undefined'
      ? ''
      : `${navigator.platform} ${navigator.userAgent}`;
  return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘F' : 'Ctrl+F';
}

/**
 * Browser-style quick-find over the rendered conversation: open with Ctrl+F / ⌘F,
 * type to match, Enter / Shift+Enter (or F3 / ⇧F3, ⌘G) to walk the matches, Escape to
 * close. Matches are painted with CSS Custom Highlights, so streaming React re-renders
 * never have to compete with injected `<mark>` nodes.
 */
export function ChatFind({ containerRef, onReveal }: ChatFindProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const indexRef = useRef<TranscriptIndex | null>(null);
  const layersRef = useRef<Range[][]>([]);
  const activeRef = useRef(-1);
  /** Set by content-change re-scans so they don't yank the view around. */
  const keepPositionRef = useRef(false);
  const [revision, setRevision] = useState(0);

  const reveal = useCallback(
    (index: number) => {
      const ranges = layersRef.current[index];
      if (ranges && ranges.length > 0) onReveal(ranges);
    },
    [onReveal],
  );

  const close = useCallback(() => {
    setOpen(false);
    clearHighlights();
  }, []);

  const show = useCallback(() => {
    setOpen(true);
    // Quick-find convention: a non-empty selection seeds the query.
    const selection = (window.getSelection()?.toString() ?? '').trim();
    if (selection && !selection.includes('\n')) setQuery(selection);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
  }, []);

  const step = useCallback(
    (delta: number) => {
      const count = layersRef.current.length;
      if (count === 0) return;
      const next = (((activeRef.current + delta) % count) + count) % count;
      activeRef.current = next;
      setActive(next);
      paintHighlights(layersRef.current, next);
      reveal(next);
    },
    [reveal],
  );

  // Global keys: the shortcut has to work with focus anywhere (including the
  // composer), and capture + stopPropagation keeps VS Code's own Ctrl+F and the
  // "Escape aborts the run" binding from firing underneath the bar.
  useEffect(() => {
    const onKeyDown = (e: WindowEventMap['keydown']) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        show();
        return;
      }
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (
        e.key === 'F3' ||
        (mod && !e.altKey && (e.key === 'g' || e.key === 'G'))
      ) {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, show, close, step]);

  // Re-index when the transcript changes underneath an open bar: streamed text, and
  // `aria-hidden` flips from expanding a collapsed tool / thinking block.
  useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        indexRef.current = null;
        keepPositionRef.current = true;
        setRevision((n) => n + 1);
      }, REINDEX_DELAY);
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'data-find-skip'],
    });
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, containerRef]);

  // Search. Runs on every query/option change and on each scheduled re-index.
  useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    if (!indexRef.current) indexRef.current = indexTranscript(el);
    const index = indexRef.current;
    const hits = findMatches(index.text, query, { caseSensitive, regex });
    const layers = matchRangeSet(index, hits.matches);
    layersRef.current = layers;

    const keep = keepPositionRef.current;
    keepPositionRef.current = false;
    const previousActive = activeRef.current;
    let nextActive = -1;
    if (layers.length > 0) {
      nextActive = keep
        ? Math.min(Math.max(previousActive, 0), layers.length - 1)
        : 0;
    }
    activeRef.current = nextActive;
    setActive(nextActive);
    setTotal(layers.length);
    setCapped(hits.capped);
    setError(hits.error ?? null);
    paintHighlights(layers, nextActive);
    // A new query reveals its first match; a content-triggered re-scan only scrolls
    // when the match the reader was on disappeared (clamped to a different one).
    if (nextActive >= 0 && (!keep || nextActive !== previousActive)) {
      reveal(nextActive);
    }
  }, [open, query, caseSensitive, regex, revision, containerRef, reveal]);

  // Drop everything the moment the bar closes — highlights and the index, which is
  // the big object here (it holds live references to every text node).
  useEffect(() => {
    if (open) return;
    clearHighlights();
    indexRef.current = null;
    layersRef.current = [];
    activeRef.current = -1;
    setActive(-1);
    setTotal(0);
    setCapped(false);
    setError(null);
  }, [open]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.altKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      setCaseSensitive((v) => !v);
    } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      setRegex((v) => !v);
    }
  };

  if (!open) return null;

  const hasMatches = total > 0;
  const countLabel = error
    ? 'Bad pattern'
    : formatFindCount(active, total, capped);

  return (
    <div className="chat-find" role="search">
      <input
        ref={inputRef}
        className="chat-find-input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder={`Find in conversation (${findShortcutLabel()})`}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Find in conversation"
        aria-invalid={!!error || (query.length > 0 && !hasMatches)}
      />
      <span
        className={`chat-find-count${error ? ' is-error' : ''}`}
        title={error ?? undefined}
        aria-live="polite">
        {countLabel}
      </span>
      <div className="chat-find-actions">
        <IconButton
          icon={LuCaseSensitive}
          label="Match case (Alt+C)"
          tooltip="Match case (Alt+C)"
          size="sm"
          className={`chat-find-toggle${caseSensitive ? ' is-active' : ''}`}
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        />
        <IconButton
          icon={LuRegex}
          label="Use regular expression (Alt+R)"
          tooltip="Use regular expression (Alt+R)"
          size="sm"
          className={`chat-find-toggle${regex ? ' is-active' : ''}`}
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        />
        <IconButton
          icon={LuChevronUp}
          label="Previous match (Shift+Enter)"
          tooltip="Previous match (Shift+Enter)"
          size="sm"
          disabled={!hasMatches}
          onClick={() => step(-1)}
        />
        <IconButton
          icon={LuChevronDown}
          label="Next match (Enter)"
          tooltip="Next match (Enter)"
          size="sm"
          disabled={!hasMatches}
          onClick={() => step(1)}
        />
        <IconButton
          icon={LuX}
          label="Close (Escape)"
          tooltip="Close (Escape)"
          size="sm"
          onClick={close}
        />
      </div>
    </div>
  );
}
