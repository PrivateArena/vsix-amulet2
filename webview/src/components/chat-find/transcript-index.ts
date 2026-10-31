import type { FindMatch } from '../../utils/find-query';

/**
 * Transcript text index for quick-find.
 *
 * The conversation is rendered HTML — markdown, syntax-highlighted code, tool
 * blocks — so a search needs one flat haystack plus a map back to the DOM. Text
 * nodes are concatenated in document order, with a `\n` inserted whenever the
 * containing block changes: that keeps inline splits (`foo <b>bar</b>`) searchable as
 * one word while blocking matches that straddle two paragraphs.
 *
 * Highlighting uses the CSS Custom Highlight API, which paints `Range`s without
 * touching the DOM. That matters here: the transcript is React-owned and streams
 * continuously, so injecting `<mark>` elements would fight the renderer.
 */

/** A text node and where its content starts in the haystack. */
interface Segment {
  node: Text;
  start: number;
  length: number;
}

export interface TranscriptIndex {
  text: string;
  segments: Segment[];
}

/** Ceiling on the haystack so a huge session can't lock the renderer on reindex. */
export const MAX_INDEX_CHARS = 4_000_000;

/** Elements whose text is either not prose or not searchable content. */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'TEMPLATE',
]);

/** Block-level tags: crossing one inserts a `\n` separator into the haystack. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'OUTPUT',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/** Highlight layer names, styled in `chat-find.scss`. */
export const FIND_HIGHLIGHT = 'amulet-find-match';
export const FIND_HIGHLIGHT_ACTIVE = 'amulet-find-active';

/**
 * Hidden subtrees are skipped, matching browser find behaviour. Collapsed tool and
 * thinking blocks toggle `aria-hidden` (their content stays mounted so collapsing
 * can animate), so searching them would offer jumps into a clipped-over area.
 * `data-find-skip` opts an element out explicitly.
 */
function isExcluded(el: Element): boolean {
  return (
    SKIP_TAGS.has(el.tagName) ||
    el.hasAttribute('data-find-skip') ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

function nearestBlock(el: Element | null, root: Element): Element {
  let node = el;
  while (node && node !== root) {
    if (BLOCK_TAGS.has(node.tagName)) return node;
    node = node.parentElement;
  }
  return root;
}

/**
 * CSS-hidden text (a collapsed `display: none` reasoning body, a node React has since
 * unmounted) has no boxes to highlight or scroll to, so it stays out of the haystack —
 * the same thing browser find does. `checkVisibility` covers `display: none`,
 * `visibility: hidden` and hidden ancestors; it is cached per element so the walk pays
 * for one call per text parent, not per node.
 */
function isVisible(el: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  // Without the API, trust the aria-hidden pruning above.
  const visible =
    typeof el.checkVisibility !== 'function' ||
    el.checkVisibility({ checkVisibilityCSS: true });
  cache.set(el, visible);
  return visible;
}

/** Walk `root` and build the haystack + segment map. */
export function indexTranscript(root: HTMLElement): TranscriptIndex {
  const visibility = new Map<Element, boolean>();
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Rejecting an element prunes its subtree, which is how collapsed tool /
          // thinking blocks (aria-hidden wrappers) get excluded.
          return isExcluded(node as Element)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        }
        const text = node as Text;
        if (!text.data) return NodeFilter.FILTER_REJECT;
        const host = text.parentElement;
        if (!host || !isVisible(host, visibility))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  const segments: Segment[] = [];
  let text = '';
  let lastBlock: Element | null = null;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const segment = node as Text;
    const block = nearestBlock(segment.parentElement, root);
    if (lastBlock && block !== lastBlock) text += '\n';
    lastBlock = block;
    segments.push({
      node: segment,
      start: text.length,
      length: segment.data.length,
    });
    text += segment.data;
    if (text.length >= MAX_INDEX_CHARS) break;
  }

  return { text, segments };
}

/** First segment that could contain `offset` (segments are ordered by `start`). */
function lowerBound(segments: Segment[], offset: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].start + segments[mid].length <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** DOM ranges covering one match (several when it spans inline markup). */
export function matchRanges(index: TranscriptIndex, match: FindMatch): Range[] {
  const ranges: Range[] = [];
  const end = match.start + match.length;
  const segments = index.segments;
  for (let i = lowerBound(segments, match.start); i < segments.length; i++) {
    const seg = segments[i];
    if (seg.start >= end) break;
    const from = Math.max(seg.start, match.start) - seg.start;
    const to = Math.min(seg.start + seg.length, end) - seg.start;
    if (to <= from) continue;
    const range = document.createRange();
    try {
      range.setStart(seg.node, from);
      range.setEnd(seg.node, to);
    } catch {
      // Node detached between indexing and painting (streaming re-render) — skip it.
      continue;
    }
    ranges.push(range);
  }
  return ranges;
}

/** Ranges for every match, in match order. */
export function matchRangeSet(
  index: TranscriptIndex,
  matches: FindMatch[],
): Range[][] {
  return matches.map((match) => matchRanges(index, match));
}

/** `true` when the Custom Highlight API is available (Chromium ≥ 105). */
export function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof Highlight !== 'undefined'
  );
}

/**
 * Paint all matches, plus `activeIndex` on its own layer. No-op where the API is
 * missing — navigation and scrolling still work, just without the tints.
 */
export function paintHighlights(layers: Range[][], activeIndex: number): void {
  if (!supportsHighlightApi()) return;
  const all = new Highlight();
  const active = new Highlight();
  layers.forEach((ranges, index) => {
    for (const range of ranges) {
      all.add(range);
      if (index === activeIndex) active.add(range);
    }
  });
  CSS.highlights.set(FIND_HIGHLIGHT, all);
  CSS.highlights.set(FIND_HIGHLIGHT_ACTIVE, active);
}

export function clearHighlights(): void {
  if (!supportsHighlightApi()) return;
  CSS.highlights.delete(FIND_HIGHLIGHT);
  CSS.highlights.delete(FIND_HIGHLIGHT_ACTIVE);
}
