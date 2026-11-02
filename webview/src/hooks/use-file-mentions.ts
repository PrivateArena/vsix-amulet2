import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useProjectFilesStore,
  projectFiles,
} from '../stores/project-files-store';
import {
  FILE_MENTION_LIMIT,
  parseAtToken,
  rankFileMentions,
  type AtTokenRange,
  type FileMention,
} from '../utils/at-mention';
import { useListNavigation } from './use-list-navigation';

interface UseFileMentionsOptions {
  /** Current textarea value. */
  value: string;
  /** Caret offset in `value`; the menu only tracks a token at the caret. */
  caret?: number;
  /** Called when a path is picked, with the range its `@token` occupies. */
  onSelect: (mention: FileMention, token: AtTokenRange) => void;
  /** Called when the user presses Escape: the caller hides the menu for this token. */
  onDismiss?: (token: AtTokenRange, query: string) => void;
}

interface UseFileMentionsReturn {
  /** Whether the file menu is currently visible. */
  visible: boolean;
  /** Ranked rows to render (already capped). */
  items: FileMention[];
  focused: number;
  /** Called on textarea keydown. Returns true if the event was consumed. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onHover: (index: number) => void;
  /** The path typed after `@`. */
  query: string;
  /** Range of the in-progress `@token`, for the caller that inserts. */
  token: AtTokenRange | null;
  /** Directory the listing describes. */
  cwd: string;
  /** Sole row to show when there is nothing to list, phrased for the menu. */
  note?: string;
  /** Footer note: how much of the tree the listing really is. */
  hint?: string;
}

/**
 * Completes `@paths` in the composer: parses the token, asks the host for the project
 * listing once the menu opens, and ranks it in memory so keystrokes never round-trip.
 *
 * The listing is shared through the store, so navigating with several `@`s in one message
 * reuses it; a search that matches nothing re-asks once — that is exactly the case of a
 * file the agent has just created, which the cached tree cannot know about.
 */
export function useFileMentions({
  value,
  caret,
  onSelect,
  onDismiss,
}: UseFileMentionsOptions): UseFileMentionsReturn {
  const match = useMemo(() => parseAtToken(value), [value]);
  const query = match?.query ?? '';

  const paths = useProjectFilesStore((s) => s.paths);
  const cwd = useProjectFilesStore((s) => s.cwd);
  const pendingId = useProjectFilesStore((s) => s.requestId);
  const truncated = useProjectFilesStore((s) => s.truncated);
  const error = useProjectFilesStore((s) => s.error);

  // A caret moved back into the text means the trailing token is not what the user is
  // completing, so the menu would insert in the wrong place.
  const atCaret = caret === undefined || caret >= value.length;
  const visible = match !== null && atCaret;

  const loading = pendingId !== null;

  useEffect(() => {
    if (visible) projectFiles.request();
  }, [visible]);

  const items = useMemo(
    () => (visible ? rankFileMentions(paths, query, FILE_MENTION_LIMIT) : []),
    [paths, query, visible],
  );

  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || loading) return;
    if (items.length > 0 || !query) return;
    if (refreshedFor.current === query) return;
    refreshedFor.current = query;
    projectFiles.request(true);
  }, [items.length, loading, query, visible]);

  const selectItem = useCallback(
    (item: FileMention) => {
      if (!match) return;
      onSelect(item, { start: match.start, end: match.end });
    },
    [match, onSelect],
  );

  // ArrowUp/ArrowDown/Enter navigation is shared with the command menu; Tab/Escape are not.
  const nav = useListNavigation({
    count: items.length,
    cycle: true,
    onSelect: (i) => selectItem(items[i]),
  });
  const { focused, setFocused } = nav;

  const prevQuery = useRef(query);
  if (query !== prevQuery.current) {
    prevQuery.current = query;
    if (focused !== 0) setFocused(0);
  }

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!visible || items.length === 0) return false;
      if (e.key === 'Tab') {
        e.preventDefault();
        if (focused >= 0 && focused < items.length) selectItem(items[focused]);
        return true;
      }
      // Escape dismisses this token's menu instead of aborting the run underneath it.
      if (e.key === 'Escape') {
        e.preventDefault();
        if (match) onDismiss?.({ start: match.start, end: match.end }, query);
        return true;
      }
      return nav.onKeyDown(e);
    },
    [visible, items, focused, selectItem, nav, match, query, onDismiss],
  );

  const rootName =
    cwd
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? cwd;
  // An empty list has to explain itself — it is also the cold-start and the failed-scan
  // case, and a menu that silently hides would look like a missing feature.
  const note = items.length
    ? undefined
    : loading
      ? 'Scanning project files…'
      : error
        ? error
        : paths.length === 0
          ? 'No project files to list'
          : query
            ? `No file matches “${query}”`
            : undefined;

  return {
    visible,
    items,
    focused,
    onKeyDown,
    onHover: setFocused,
    query,
    token: visible && match ? { start: match.start, end: match.end } : null,
    cwd,
    note,
    hint:
      truncated && rootName
        ? `partial listing · ${rootName}`
        : rootName || undefined,
  };
}
