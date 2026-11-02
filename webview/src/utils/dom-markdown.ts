/**
 * Rendered chat markup back into text — the reverse of `MdRender`.
 *
 * The webview keeps the markdown *source* of every message body, so a whole-block
 * copy is byte-exact without any conversion. A partial selection (one paragraph, a
 * few table rows) only exists as rendered DOM, and that is what this serializes:
 * GitHub-flavoured markdown, or decoration-free text with the `plain` flavour.
 *
 * It runs against a structural slice of the DOM (see {@link DomLike}) so the logic
 * stays pure and testable in Node, where the suite has no DOM.
 *
 * Deliberate limit: text is not markdown-escaped (the source came out of a markdown
 * renderer, so escaping would double the backslashes). Only table cells escape `|`,
 * which GFM needs to keep a table parseable.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FRAGMENT_NODE = 11;

/** A node as far as the serializer cares: {@link Node} satisfies it structurally. */
export interface DomLike {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<DomLike>;
  readonly textContent: string | null;
  getAttribute?(name: string): string | null;
}

export interface SerializeOptions {
  /** `markdown` keeps the syntax, `plain` drops decoration and link targets. */
  flavor?: 'markdown' | 'plain';
  /** False leaves the ``` fences off a code block (see the table-cell path). */
  fence?: boolean;
  /** The root is preformatted text (a `<pre>`, a `white-space: pre-wrap` body). */
  pre?: boolean;
}

interface Ctx {
  flavor: 'markdown' | 'plain';
  pre: boolean;
}

/** Elements that start their own block, so a container holding one is not inline. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD']);

/** Two trailing spaces: the only hard line break markdown has. */
const HARD_BREAK = '  \n';

function tagName(node: DomLike): string {
  return node.nodeName.toUpperCase();
}

function childList(node: DomLike): DomLike[] {
  const out: DomLike[] = [];
  for (let i = 0; i < node.childNodes.length; i++) out.push(node.childNodes[i]);
  return out;
}

function isElement(node: DomLike): boolean {
  return node.nodeType === ELEMENT_NODE;
}

function isBlockElement(node: DomLike): boolean {
  return isElement(node) && BLOCK_TAGS.has(tagName(node));
}

/** HTML whitespace collapsing: runs of space/newline become one space. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function oneLine(text: string): string {
  return collapse(text).trim();
}

/** Serialize a rendered subtree (a node, a range fragment) into text. */
export function serializeDom(
  node: DomLike,
  options: SerializeOptions = {},
): string {
  const ctx: Ctx = {
    flavor: options.flavor ?? 'markdown',
    pre: options.pre === true,
  };
  const blocks = renderBlocks(node, ctx, options.fence !== false);
  // Under `pre` the blocks are the lines of the payload: neither joined apart, nor
  // squashed afterwards.
  const joined = blocks.join(ctx.pre ? '\n' : '\n\n');
  return (ctx.pre ? joined : joined.replace(/\n{3,}/g, '\n\n')).trim();
}

/** Blocks of a subtree, in document order, each already self-contained. */
function renderBlocks(node: DomLike, ctx: Ctx, fence: boolean): string[] {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? '';
    return /\S/.test(text)
      ? [ctx.pre ? text.trim() : collapse(text).trim()]
      : [];
  }
  if (!isElement(node) && node.nodeType !== FRAGMENT_NODE) return [];

  const tag = tagName(node);
  if (SKIP_TAGS.has(tag)) return [];

  if (tag === 'PRE') return [codeBlock(node, ctx, fence)];
  if (
    tag === 'TABLE' ||
    tag === 'THEAD' ||
    tag === 'TBODY' ||
    tag === 'TFOOT'
  ) {
    return [tableBlock(node, ctx)];
  }
  if (tag === 'TR') return [tableBlock(node, ctx)];
  if (tag === 'HR') return [ctx.flavor === 'markdown' ? '---' : ''];
  if (/^H[1-6]$/.test(tag)) {
    const text = oneLine(flow(node, ctx));
    if (!text) return [];
    const hash = ctx.flavor === 'markdown' ? '#'.repeat(+tag[1]) + ' ' : '';
    return [hash + text];
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = renderChildren(node, ctx, fence).join('\n\n');
    if (!inner.trim()) return [];
    return [
      inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n'),
    ];
  }
  if (tag === 'UL' || tag === 'OL') return [listBlock(node, ctx, fence)];

  return renderChildren(node, ctx, fence);
}

function renderChildren(node: DomLike, ctx: Ctx, fence: boolean): string[] {
  const kids = childList(node);
  if (!kids.some(isBlockElement)) {
    // No block children: the whole subtree is one paragraph of inline flow.
    const paragraph = flow(node, ctx).trim();
    return paragraph ? [paragraph] : [];
  }

  // Mixed content: keep the blocks and any prose that sits between them.
  const blocks: string[] = [];
  for (const kid of kids) {
    if (isBlockElement(kid)) {
      blocks.push(...renderBlocks(kid, ctx, fence));
      continue;
    }
    const inline = flow(kid, ctx).trim();
    if (inline) blocks.push(inline);
  }
  return blocks;
}

function listBlock(node: DomLike, ctx: Ctx, fence: boolean): string {
  const ordered = tagName(node) === 'OL';
  const start = ordered
    ? parseInt(node.getAttribute?.('start') ?? '1', 10) || 1
    : 1;
  const items: string[] = [];
  let n = start;
  for (const kid of childList(node)) {
    if (!isElement(kid) || tagName(kid) !== 'LI') continue;
    const body = joinItemBlocks(renderChildren(kid, ctx, fence));
    if (!body.trim()) {
      items.push(ordered ? `${n++}.` : '-');
      continue;
    }
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    const lines = body.split('\n');
    // The first line takes the marker; a blank line stays blank, so a loose item's
    // paragraphs do not run together.
    items.push(
      lines
        .map((line, i) => (i === 0 ? marker + line : line ? pad + line : line))
        .join('\n'),
    );
  }
  return items.join('\n');
}

/**
 * Blocks of one list item. A nested list continues the item on the next line; anything
 * else (a second paragraph) is a real break and keeps its blank line.
 */
function joinItemBlocks(blocks: string[]): string {
  return blocks.reduce((acc, part) => {
    if (!acc) return part;
    if (!part) return acc;
    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s/.test(part);
    return `${acc}${isListItem ? '\n' : '\n\n'}${part}`;
  }, '');
}

function codeBlock(node: DomLike, ctx: Ctx, fence: boolean): string {
  const code = preText(node).replace(/^\n+/, '').replace(/\s+$/, '');
  if (ctx.flavor === 'plain') return code;
  if (!fence) return code;
  const lang = fenceLanguage(node);
  // A fence has to out-length any run of backticks inside the payload.
  const run = (code.match(/`+/g) ?? []).reduce(
    (m, s) => Math.max(m, s.length),
    0,
  );
  const tick = '`'.repeat(Math.max(3, run + 1));
  return `${tick}${lang}\n${code}\n${tick}`;
}

/**
 * The text of a `<pre>`. Highlighted code is one `<code>` child whose `textContent`
 * carries its own newlines, but a patch paints a `<div>` per line — and the whole
 * `<pre>`'s `textContent` glues those rows into one run-on line.
 */
function preText(node: DomLike): string {
  const rows = childList(node).filter(isBlockElement);
  if (rows.length === 0) return node.textContent ?? '';
  return rows.map((row) => row.textContent ?? '').join('\n');
}

/** Language of a code block, from the class `rehype-highlight` puts on the `<code>`. */
function fenceLanguage(pre: DomLike): string {
  const codes = childList(pre).filter(
    (n) => isElement(n) && tagName(n) === 'CODE',
  );
  const pool = codes.length > 0 ? codes : [pre];
  for (const el of pool) {
    for (const cls of (el.getAttribute?.('class') ?? '').split(/\s+/)) {
      if (cls.startsWith('language-')) return cls.slice('language-'.length);
      if (cls.startsWith('lang-')) return cls.slice('lang-'.length);
    }
  }
  return '';
}

function tableBlock(node: DomLike, ctx: Ctx): string {
  const rows: DomLike[] = [];
  const collect = (el: DomLike) => {
    for (const kid of childList(el)) {
      if (!isElement(kid)) continue;
      const tag = tagName(kid);
      if (tag === 'TR') rows.push(kid);
      else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT')
        collect(kid);
    }
  };
  // The serializer may be handed a `<tbody>`/`<tr>` selected directly out of a table.
  if (tagName(node) === 'TR') rows.push(node);
  else collect(node);

  const grid = rows.map((row) =>
    childList(row)
      .filter((cell) => isElement(cell) && /^(TH|TD)$/.test(tagName(cell)))
      .map((cell) => {
        const text = oneLine(renderChildren(cell, ctx, false).join(' '));
        return ctx.flavor === 'markdown' ? text.replace(/\|/g, '\\|') : text;
      }),
  );
  const width = grid.reduce((max, cells) => Math.max(max, cells.length), 0);
  if (width === 0) return '';

  const pad = (cells: string[]) => [
    ...cells,
    ...Array<string>(Math.max(0, width - cells.length)).fill(''),
  ];
  const line = (cells: string[]) => `| ${pad(cells).join(' | ')} |`;
  const out = [line(grid[0])];
  if (ctx.flavor === 'markdown') {
    out.push(`| ${Array<string>(width).fill('---').join(' | ')} |`);
    out.push(...grid.slice(1).map(line));
  } else {
    out.push(...grid.slice(1).map(line));
  }
  return out.join('\n');
}

/** Inline flow text: no block structure, one logical line (bar `<br>` breaks). */
/**
 * One child in a flow position. A block child (a paragraph of a loose `<li>`, a `<div>`
 * row of a patch, a nested list) keeps its own structure instead of being flattened
 * onto the line — which is why this must not call `flow` on the node itself.
 */
function flowChild(node: DomLike, ctx: Ctx): string {
  if (isBlockElement(node)) return renderBlocks(node, ctx, true).join('\n\n');
  return flow(node, ctx);
}

function flow(node: DomLike, ctx: Ctx): string {
  if (node.nodeType === TEXT_NODE)
    return ctx.pre
      ? (node.textContent ?? '')
      : collapse(node.textContent ?? '');
  if (!isElement(node)) {
    // A fragment inside a flow position still has to contribute its text.
    return childList(node)
      .map((kid) => flowChild(kid, ctx))
      .join('');
  }

  const tag = tagName(node);
  if (SKIP_TAGS.has(tag)) return '';
  if (tag === 'BR') return ctx.flavor === 'markdown' ? HARD_BREAK : '\n';
  if (tag === 'HR') return '';
  if (tag === 'IMG') {
    const alt = oneLine(node.getAttribute?.('alt') ?? '');
    if (ctx.flavor === 'plain') return alt;
    const src = node.getAttribute?.('src') ?? '';
    return src ? `![${alt}](${src})` : alt;
  }
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'VAR') {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    return tag === 'CODE' ? inlineCode(text, ctx) : text;
  }
  if (tag === 'A') {
    const text = oneLine(
      childList(node)
        .map((kid) => flowChild(kid, ctx))
        .join(''),
    );
    const href = node.getAttribute?.('href') ?? '';
    if (ctx.flavor === 'plain')
      return href && text !== href ? `${text} (${href})` : text || href;
    if (!href) return text;
    return `[${text}](${href})`;
  }
  if (tag === 'PRE') return preText(node).replace(/\s+$/, '');
  if (tag === 'INPUT') {
    // A task list item: the renderer emits a real checkbox, whose state is the text.
    if ((node.getAttribute?.('type') ?? '').toLowerCase() !== 'checkbox')
      return '';
    return node.getAttribute?.('checked') !== null ? '[x] ' : '[ ] ';
  }

  const inner = tidy(
    childList(node)
      .map((kid) => flowChild(kid, ctx))
      .join(''),
    ctx,
  );
  if (!inner.trim()) return inner;

  if (ctx.flavor === 'plain') return inner;
  if (tag === 'STRONG' || tag === 'B') return mark(inner, '**');
  if (tag === 'EM' || tag === 'I') return mark(inner, '_');
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE')
    return mark(inner, '~~');
  return inner;
}

/**
 * Wrap flow text in an emphasis marker, keeping the markers against the words:
 * `** bold **` is not emphasis in markdown, `**bold**` is.
 */
function mark(inner: string, marker: string): string {
  const lead = inner.match(/^\s*/)?.[0] ?? '';
  const tail = inner.match(/\s*$/)?.[0] ?? '';
  const body = inner.slice(lead.length, inner.length - tail.length);
  if (!body) return inner;
  return `${lead}${marker}${body}${marker}${tail}`;
}

/**
 * Collapse the doubled spaces that appear when emphasis sheds its padding, while
 * leaving a hard break (`  \n`) and preformatted text alone.
 */
function tidy(text: string, ctx: Ctx): string {
  if (ctx.pre) return text;
  return text.replace(/ {2,}(?!\n)/g, ' ');
}

function inlineCode(text: string, ctx: Ctx): string {
  if (ctx.flavor === 'plain' || !text) return text;
  const run = (text.match(/`+/g) ?? []).reduce(
    (m, s) => Math.max(m, s.length),
    0,
  );
  const tick = '`'.repeat(run + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${tick}${pad}${text}${pad}${tick}`;
}
