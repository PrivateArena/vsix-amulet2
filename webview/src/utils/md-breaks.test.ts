import { describe, expect, it } from 'vitest';
import { applyLineBreaks } from './md-breaks';

type Node = Record<string, unknown> & { type: string };

const paragraph = (...children: Node[]): Node => ({
  type: 'paragraph',
  children,
});

const text = (value: string): Node => ({ type: 'text', value });
const code = (value: string): Node => ({ type: 'inlineCode', value });
const breakNode = (): Node => ({ type: 'break' });

const tree = (...children: Node[]): Node => ({ type: 'root', children });

const shapes = (root: Node): Node[] =>
  (root.children as Node[]).flatMap((child) =>
    child.type === 'paragraph'
      ? (child.children as Node[]).map((n) => ({
          type: n.type,
          ...(n.value === undefined ? {} : { value: n.value }),
        }))
      : [child],
  );

describe('applyLineBreaks', () => {
  it('turns the soft break the composer typed into a real line break', () => {
    const root = tree(paragraph(text('1\n2')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: '1' },
      { type: 'break' },
      { type: 'text', value: '2' },
    ]);
  });

  it('keeps every line of a multi-line paragraph', () => {
    const root = tree(paragraph(text('one\ntwo\nthree')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: 'one' },
      { type: 'break' },
      { type: 'text', value: 'two' },
      { type: 'break' },
      { type: 'text', value: 'three' },
    ]);
  });

  it('drops the blanks markdown would have swallowed before the break', () => {
    const root = tree(paragraph(text('draft   \nnext')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: 'draft' },
      { type: 'break' },
      { type: 'text', value: 'next' },
    ]);
  });

  it('leaves a line that only ends in a newline without an empty text node', () => {
    const root = tree(paragraph(text('end\n')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: 'end' },
      { type: 'break' },
    ]);
  });

  it('reaches text nested in emphasis and links, but never a literal', () => {
    const root = tree(
      paragraph({ type: 'emphasis', children: [text('a\nb')] }),
      paragraph(code('a\nb'), text('\n')),
    );
    applyLineBreaks(root);
    const emphasis = ((root.children as Node[])[0]!.children as Node[])[0]!
      .children as Node[];
    expect(emphasis.map((n) => n.type)).toEqual(['text', 'break', 'text']);
    const literal = (root.children as Node[])[1]!.children as Node[];
    expect(literal[0]).toEqual({ type: 'inlineCode', value: 'a\nb' });
  });

  it('does not stack a break onto a hand-written hard break', () => {
    const root = tree(paragraph(text('a'), breakNode(), text('b\n')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: 'a' },
      { type: 'break' },
      { type: 'text', value: 'b' },
      { type: 'break' },
    ]);
  });

  it('is a no-op on a paragraph without newlines', () => {
    const root = tree(paragraph(text('a'), breakNode(), text('b')));
    applyLineBreaks(root);
    expect(shapes(root)).toEqual([
      { type: 'text', value: 'a' },
      { type: 'break' },
      { type: 'text', value: 'b' },
    ]);
  });
});
