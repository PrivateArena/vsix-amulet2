/**
 * A newline in a chat transcript is a line break, not a space.
 *
 * Markdown's own rule is that a single `\n` inside a paragraph is a *soft break* and
 * renders as whitespace, so a composer draft of `1<enter>2` came back as `1 2` and only
 * `1<enter><enter>2` kept the break — which reads as "my Enter key did nothing", and
 * costs a second keystroke on every line. Both halves of this transcript are written
 * line-first: the human types into a textarea, and the model writes for a terminal where
 * a newline has always been a newline. So the projection of that text into HTML must not
 * invent a rule neither author was following.
 *
 * `remark-breaks` does exactly this; this is the dependency-free form of it, walking the
 * tree itself because the only node it may touch is a `text` leaf. `code`/`inlineCode` are
 * different node types, so a newline inside a fenced block or a `` `literal` `` is never
 * turned into a break, and a hand-written hard break (two trailing spaces or a backslash)
 * is already a `break` node and is left alone.
 */

/** The slice of an mdast tree this plugin knows about. */
interface MdastNode {
  type: string;
  value?: unknown;
  children?: MdastNode[];
}

/** Trailing blanks before a line end: markdown would never have rendered them. */
const TRAILING_BLANKS = /[ \t]+$/;

/** A `text` node, or nothing at all for an empty line (a break already says it). */
function textNode(value: string): MdastNode | null {
  return value ? { type: 'text', value } : null;
}

/** One `text` node that contains newlines, as text/break/text/break/… */
function splitOnNewlines(value: string): MdastNode[] {
  const lines = value.split('\n');
  const nodes: MdastNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const last = i === lines.length - 1;
    const node = textNode(
      last ? lines[i]! : lines[i]!.replace(TRAILING_BLANKS, ''),
    );
    if (node) nodes.push(node);
    if (!last) nodes.push({ type: 'break' });
  }
  return nodes;
}

function rewriteChildren(children: MdastNode[]): MdastNode[] {
  const next: MdastNode[] = [];
  for (const child of children) {
    if (
      child.type === 'text' &&
      typeof child.value === 'string' &&
      child.value.includes('\n')
    ) {
      next.push(...splitOnNewlines(child.value));
      continue;
    }
    if (child.children) child.children = rewriteChildren(child.children);
    next.push(child);
  }
  return next;
}

/**
 * Replace every soft newline in `tree` with a hard break, in place.
 * Exported apart from the plugin so the transform is testable without a parser.
 */
export function applyLineBreaks(tree: MdastNode): void {
  if (tree.children) tree.children = rewriteChildren(tree.children);
}

/** Remark plugin: see the file comment for why the transcript needs it. */
export function remarkLineBreaks() {
  return (tree: MdastNode): void => {
    applyLineBreaks(tree);
  };
}
