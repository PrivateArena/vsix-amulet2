/**
 * The copyable bodies of the transcript and the text they were rendered from.
 *
 * `MdRender` (and anything else that renders a source string) registers itself here,
 * which is what lets a right-click hand back the *raw markdown* of a subagent report
 * or an assistant paragraph instead of the rendered text. Anything not registered —
 * a terminal `<pre>`, a patch — has no source, so its copy falls back to
 * {@link serializeDom} on the live DOM.
 */
import { serializeDom, type DomLike } from './dom-markdown';

/** What a right-click can act on as one body: registered blocks and raw output. */
export const COPY_UNIT_SELECTOR = '[data-copy-unit], pre';

/** The markdown a unit was rendered from, keyed by the element showing it. */
interface UnitSource {
  /** The text the unit renders. */
  text: string;
  /** True when the unit is preformatted, so whitespace is content, not layout. */
  pre?: boolean;
}

const sources = new WeakMap<Element, UnitSource>();

/** Remember the source behind a rendered block. Re-called whenever it changes. */
export function registerCopySource(
  el: Element | null | undefined,
  text: string,
  options: { pre?: boolean } = {},
): void {
  if (el) sources.set(el, { text, pre: options.pre });
}

/** The source of a registered unit, or `undefined` for DOM-only content. */
export function copySourceOf(
  el: Element | null | undefined,
): string | undefined {
  return el ? sources.get(el)?.text : undefined;
}

/** Text of a target, in both flavours, plus where the text came from. */
export interface CopyText {
  plain: string;
  /** Rendered-back markdown, or the registered raw source when one exists. */
  markdown: string;
  /** True when `markdown` is the untouched source rather than a conversion. */
  raw: boolean;
}

/** Everything the chat context menu needs, snapshotted before it opens. */
export interface CopySnapshot {
  unit: HTMLElement;
  /** The whole block under the cursor. */
  block: CopyText;
  /** The live selection inside that block, absent when nothing is selected. */
  selection?: CopyText;
}

/** Whitespace-insensitive compare: a selection never matches markup exactly. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const left = norm(a);
  const right = norm(b);
  return left.length > 0 && left === right;
}

function textOf(node: DomLike, source?: string, pre = false): CopyText {
  const plain = serializeDom(node, { flavor: 'plain', pre });
  if (source !== undefined) return { plain, markdown: source, raw: true };
  const markdown = serializeDom(node, { flavor: 'markdown', pre });
  return { plain, markdown, raw: false };
}

/** The unit a right-click landed on, or `null` when it landed outside the transcript. */
function copyUnitAt(
  target: EventTarget | null,
  scope: HTMLElement,
): HTMLElement | null {
  const el =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!el || !scope.contains(el)) return null;
  const unit = el.closest<HTMLElement>(COPY_UNIT_SELECTOR);
  return unit && scope.contains(unit) ? unit : null;
}

/**
 * Snapshot the block (and selection) a right-click should act on.
 *
 * Read *now*, at the moment of the right-click: the click on a menu item moves focus,
 * and a selection read afterwards is gone. A selection that covers the whole unit is
 * treated as the unit, so copying a full report yields its source rather than a
 * re-serialization of it. A selection that runs outside the unit is ignored — the
 * block under the cursor is what the menu speaks for.
 */
export function copySnapshotFor(
  scope: HTMLElement,
  target: EventTarget | null,
): CopySnapshot | null {
  const unit = copyUnitAt(target, scope);
  if (!unit) return null;

  // Preformatted is a property of the content, not only of what registered it: a
  // terminal `<pre>` has no source, and its newlines are still content.
  const pre = sources.get(unit)?.pre === true || unit.tagName === 'PRE';
  const block = textOf(
    unit as unknown as DomLike,
    sources.get(unit)?.text,
    pre,
  );

  const sel = unit.ownerDocument?.defaultView?.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return { unit, block };
  const range = sel.getRangeAt(0);
  // The common ancestor holds the whole selection, so this is the containment test.
  if (!unit.contains(range.commonAncestorContainer)) return { unit, block };

  // A partial selection has no source to hand back — only its own rendered DOM. Both
  // sides go through the same serializer, so "is this everything?" compares structure
  // rather than the browser's idea of a selection's text (tabs between table cells).
  const fragment = range.cloneContents() as unknown as DomLike;
  const selection = textOf(fragment, undefined, pre);
  if (!selection.plain.trim() || sameText(selection.plain, block.plain)) {
    return { unit, block };
  }
  return { unit, block, selection };
}
