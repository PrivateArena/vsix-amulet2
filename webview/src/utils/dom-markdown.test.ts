import { describe, expect, it } from 'vitest';
import { serializeDom, type DomLike } from './dom-markdown';

/**
 * The suite has no DOM, so build the structural slice the serializer reads. Real
 * nodes satisfy the same shape, which is the point of `DomLike`.
 */
function text(data: string): DomLike {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: data };
}

function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...kids: (DomLike | string)[]
): DomLike {
  const childNodes = kids.map((k) => (typeof k === 'string' ? text(k) : k));
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    childNodes,
    textContent: childNodes.map((c) => c.textContent ?? '').join(''),
    getAttribute: (name: string) => attrs[name] ?? null,
  };
}

function fragment(...kids: (DomLike | string)[]): DomLike {
  const childNodes = kids.map((k) => (typeof k === 'string' ? text(k) : k));
  return {
    nodeType: 11,
    nodeName: '#document-fragment',
    childNodes,
    textContent: childNodes.map((c) => c.textContent ?? '').join(''),
  };
}

const md = (node: DomLike) => serializeDom(node, { flavor: 'markdown' });
const plain = (node: DomLike) => serializeDom(node, { flavor: 'plain' });

describe('serializeDom', () => {
  it('joins paragraphs with a blank line and collapses html whitespace', () => {
    const node = el(
      'DIV',
      {},
      '\n  ',
      el('P', {}, 'First  para\n  still first.'),
      '\n',
      el('P', {}, 'Second.'),
    );
    expect(md(node)).toBe('First para still first.\n\nSecond.');
  });

  it('writes headings at their level', () => {
    const node = fragment(el('H1', {}, 'Title'), el('H3', {}, 'Sub'));
    expect(md(node)).toBe('# Title\n\n### Sub');
    expect(plain(node)).toBe('Title\n\nSub');
  });

  it('keeps inline emphasis, code and links as markdown', () => {
    const node = el(
      'P',
      {},
      'a ',
      el('strong', {}, 'bold'),
      ' and ',
      el('em', {}, ' italic '),
      ' and ',
      el('code', { class: 'language-ts' }, 'x | y'),
      ' then ',
      el('a', { href: 'https://pi.dev' }, 'link'),
    );
    expect(md(node)).toBe(
      'a **bold** and _italic_ and `x | y` then [link](https://pi.dev)',
    );
    expect(plain(node)).toBe(
      'a bold and italic and x | y then link (https://pi.dev)',
    );
  });

  it('does not let emphasis markers drift onto padding', () => {
    expect(md(el('P', {}, el('strong', {}, ' spaced ')))).toBe('**spaced**');
  });

  it('fences a code block with the highlighted language', () => {
    const node = el(
      'PRE',
      { class: 'md-code-block' },
      el(
        'CODE',
        { class: 'hljs language-go' },
        'func main() {\n\treturn nil\n}\n',
      ),
    );
    expect(md(node)).toBe('```go\nfunc main() {\n\treturn nil\n}\n```');
    expect(plain(node)).toBe('func main() {\n\treturn nil\n}');
  });

  it('out-lengths a fence that appears inside the payload', () => {
    const node = el('PRE', {}, el('CODE', {}, '```ls```'));
    expect(md(node)).toBe('````\n```ls```\n````');
  });

  it('numbers an ordered list and indents a nested one', () => {
    const node = el(
      'UL',
      {},
      el('LI', {}, 'one'),
      el(
        'LI',
        {},
        'two',
        el('OL', { start: '3' }, el('LI', {}, 'deep'), el('LI', {}, 'deeper')),
      ),
    );
    expect(md(node)).toBe('- one\n- two\n  3. deep\n  4. deeper');
  });

  it('prefixes a blockquote, empty lines included', () => {
    const node = el(
      'BLOCKQUOTE',
      {},
      el('P', {}, 'said'),
      el('P', {}, 'again'),
    );
    expect(md(node)).toBe('> said\n>\n> again');
  });

  it('renders a table as gfm, escaping pipes in cells', () => {
    const node = el(
      'DIV',
      { class: 'md-table-wrap' },
      el(
        'TABLE',
        { class: 'md-table' },
        el(
          'THEAD',
          {},
          el('TR', {}, el('TH', {}, 'Layer'), el('TH', {}, 'Reality')),
        ),
        el(
          'TBODY',
          {},
          el('TR', {}, el('TD', {}, 'CGO islands'), el('TD', {}, 'a | b')),
          el('TR', {}, el('TD', {}, 'Frontend')),
        ),
      ),
    );
    expect(md(node)).toBe(
      '| Layer | Reality |\n| --- | --- |\n| CGO islands | a \\| b |\n| Frontend |  |',
    );
    expect(plain(node)).toBe(
      '| Layer | Reality |\n| CGO islands | a | b |\n| Frontend |  |',
    );
  });

  it('keeps a body-row selection a valid table', () => {
    const body = el(
      'TBODY',
      {},
      el('TR', {}, el('TD', {}, 'keep'), el('TD', {}, 'row')),
    );
    // GFM needs a delimiter row, and a copied fragment has no header to borrow.
    expect(md(body)).toBe('| keep | row |\n| --- | --- |');
  });

  it('treats the head row as the header of a full table', () => {
    const table = el(
      'TABLE',
      {},
      el(
        'THEAD',
        {},
        el('TR', {}, el('TH', {}, 'Tier'), el('TH', {}, 'Content')),
      ),
      el('TBODY', {}, el('TR', {}, el('TD', {}, 'A'), el('TD', {}, 'Delete'))),
    );
    expect(md(table)).toBe('| Tier | Content |\n| --- | --- |\n| A | Delete |');
  });

  it('writes a hard break for <br> and a rule for <hr>', () => {
    expect(
      md(
        fragment(
          el('P', {}, 'one', el('br'), 'two'),
          el('HR'),
          el('P', {}, 'after'),
        ),
      ),
    ).toBe('one  \ntwo\n\n---\n\nafter');
  });

  it('keeps a div-per-line patch as lines', () => {
    const node = el(
      'PRE',
      { class: 'patch-container' },
      el('DIV', { class: 'patch-line patch-line-context' }, ' a = 1'),
      el('DIV', { class: 'patch-line patch-line-del' }, '- b = 2'),
      el('DIV', { class: 'patch-line patch-line-add' }, '+ b = 3'),
    );
    expect(md(node)).toBe('```\n a = 1\n- b = 2\n+ b = 3\n```');
  });

  it('keeps a task list checked', () => {
    const node = el(
      'UL',
      {},
      el(
        'LI',
        {},
        el('INPUT', { type: 'checkbox', checked: '' }),
        'done thing',
      ),
      el('LI', {}, el('INPUT', { type: 'checkbox' }), 'open thing'),
    );
    expect(md(node)).toBe('- [x] done thing\n- [ ] open thing');
  });

  it('separates the paragraphs of a loose list item', () => {
    const node = el(
      'UL',
      {},
      el('LI', {}, el('P', {}, 'first'), el('P', {}, 'second')),
    );
    expect(md(node)).toBe('- first\n\n  second');
  });

  it('round-trips a report body written the way the renderer emits it', () => {
    const node = el(
      'DIV',
      { class: 'entry-content-md' },
      el('H2', {}, 'Portability hazard inventory'),
      el(
        'P',
        {},
        'Totals verified: ',
        el('strong', {}, '81,934 non-test LOC'),
        ' in ',
        el('code', {}, 'pkg/*'),
        '.',
      ),
      el(
        'DIV',
        { class: 'md-table-wrap' },
        el(
          'TABLE',
          { class: 'md-table' },
          el(
            'THEAD',
            {},
            el('TR', {}, el('TH', {}, 'Tier'), el('TH', {}, 'Content')),
          ),
          el(
            'TBODY',
            {},
            el('TR', {}, el('TD', {}, 'A. Delete'), el('TD', {}, 'REST glue')),
          ),
        ),
      ),
      el(
        'UL',
        {},
        el('LI', {}, 'one'),
        el('LI', {}, 'two', el('UL', {}, el('LI', {}, 'deeper'))),
      ),
      el(
        'PRE',
        { class: 'md-code-block' },
        el('CODE', { class: 'hljs language-go' }, 'm.Lock()\n'),
      ),
    );
    expect(md(node)).toBe(
      [
        '## Portability hazard inventory',
        '',
        'Totals verified: **81,934 non-test LOC** in `pkg/*`.',
        '',
        '| Tier | Content |',
        '| --- | --- |',
        '| A. Delete | REST glue |',
        '',
        '- one',
        '- two',
        '  - deeper',
        '',
        '```go',
        'm.Lock()',
        '```',
      ].join('\n'),
    );
  });

  it('drops content the renderer should not copy', () => {
    const node = el('DIV', {}, el('STYLE', {}, '.x{}'), el('P', {}, 'real'));
    expect(md(node)).toBe('real');
  });

  it('survives an empty subtree', () => {
    expect(md(el('DIV', {}))).toBe('');
    expect(md(fragment())).toBe('');
  });
});
