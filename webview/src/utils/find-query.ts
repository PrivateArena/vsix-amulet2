/**
 * Pure quick-find matching for the transcript search bar.
 *
 * The DOM side (webview/src/components/chat-find) owns turning the transcript into
 * one haystack; this module owns the query semantics only, so the case/regex rules
 * are testable without a browser.
 */

export interface FindOptions {
  /** Distinguish upper/lower case. Off by default, like a browser's quick-find. */
  caseSensitive?: boolean;
  /** Treat the query as a regular expression (opt-in — the user accepts its cost). */
  regex?: boolean;
}

export interface FindMatch {
  /** Offset into the haystack. */
  start: number;
  /** Always > 0: zero-length matches are dropped, they cannot be highlighted. */
  length: number;
}

export interface FindHits {
  matches: FindMatch[];
  /** The scan stopped at {@link MAX_MATCHES}; more matches may exist. */
  capped: boolean;
  /** Set when the query is a syntactically invalid regex. */
  error?: string;
}

/**
 * Bound on the result list. Without it a one-letter query over a long session would
 * build tens of thousands of ranges (and Highlight entries) per keystroke.
 */
export const MAX_MATCHES = 2000;

const EMPTY: FindHits = { matches: [], capped: false };

/** Escape a literal query so it can be compiled into a search pattern. */
function escapeForPattern(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the find query. Both modes go through `RegExp` (rather than `indexOf` +
 * `toLowerCase`) so match offsets always refer to the original string — case
 * folding can change a string's length (e.g. `İ`), which would shift highlights.
 */
export function compileFindQuery(
  query: string,
  options: FindOptions = {},
): { pattern: RegExp | null; error?: string } {
  if (!query) return { pattern: null };
  const flags = options.regex
    ? options.caseSensitive
      ? 'gm'
      : 'gim'
    : options.caseSensitive
      ? 'g'
      : 'gi';
  const source = options.regex ? query : escapeForPattern(query);
  try {
    return { pattern: new RegExp(source, flags) };
  } catch (err) {
    return {
      pattern: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Find every occurrence of `query` in `haystack`. Returns nothing for an empty query. */
export function findMatches(
  haystack: string,
  query: string,
  options: FindOptions = {},
): FindHits {
  const { pattern, error } = compileFindQuery(query, options);
  if (error) return { matches: [], capped: false, error };
  if (!pattern) return EMPTY;

  const matches: FindMatch[] = [];
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(haystack)) !== null) {
    if (hit[0].length === 0) {
      // `a*`, `^` and friends match empty strings everywhere — skip past them.
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({ start: hit.index, length: hit[0].length });
    if (matches.length >= MAX_MATCHES) {
      return { matches, capped: true };
    }
  }
  return { matches, capped: false };
}

/** `"12 / 340"` label, with a `+` when the scan was capped. */
export function formatFindCount(
  active: number,
  total: number,
  capped: boolean,
): string {
  if (total === 0) return '0';
  const cap = capped ? '+' : '';
  return active < 0 ? `${total}${cap}` : `${active + 1} / ${total}${cap}`;
}
