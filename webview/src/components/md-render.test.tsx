import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebviewConfig } from '../../../shared/protocol';

// Chat components take hold of the VS Code API as they are imported; the suite has no webview.
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));
const { MdRender } = await import('./md-render');
const { applyLineBreakConfig } = await import('../stores/line-breaks-store');

/** One field of a `config` push is enough to move the renderer. */
const lineBreakConfig = (preserveLineBreaks: boolean): WebviewConfig =>
  ({ preserveLineBreaks }) as WebviewConfig;

/** React complaints that are not this feature's business (SSR and layout effects). */
function markup(node: ReactElement): string {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(node);
  } finally {
    const reported = errors.mock.calls.map(([message]) => String(message));
    errors.mockRestore();
    reported
      .filter(
        (message) =>
          !message.startsWith(
            'Warning: useLayoutEffect does nothing on the server',
          ),
      )
      .forEach((message) => console.error(message));
  }
}

/**
 * A break, in either serialisation, plus the newline the HTML writer keeps after it
 * (the DOM collapses that one, so it is not a second line break).
 */
const BREAK = /<br\s*\/?>\n?/g;

describe('MdRender line structure', () => {
  // The store is module state, so every case starts from the shipped default.
  afterEach(() => applyLineBreakConfig(lineBreakConfig(true)));

  it('paints the single newline of a composer draft as a line break', () => {
    const html = markup(<MdRender>{'1\n2'}</MdRender>);
    expect(html.replace(BREAK, '|')).toContain('1|2');
  });

  it('still renders a blank line as a paragraph', () => {
    const html = markup(<MdRender>{'1\n\n2'}</MdRender>);
    expect(html.match(/<p>/g)).toHaveLength(2);
    expect(html).not.toMatch(BREAK);
  });

  it('never breaks a line the author did not write', () => {
    // A fenced block and a hard-wrapped list keep their own whitespace rules.
    const html = markup(
      <MdRender>{'```ts\nconst a = 1;\nconst b = 2;\n```'}</MdRender>,
    );
    expect(html).not.toMatch(BREAK);
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      'const a = 1;\nconst b = 2;',
    );
  });

  it('does not stack a break onto an explicit hard break', () => {
    const html = markup(<MdRender>{'a\\\nb'}</MdRender>);
    expect(html.match(BREAK)).toHaveLength(1);
  });

  it('collapses the soft break again while the preference is off', () => {
    applyLineBreakConfig(lineBreakConfig(false));
    const html = markup(<MdRender>{'1\n2'}</MdRender>);
    expect(html).not.toMatch(BREAK);
    // Either way the bytes the author typed survive untouched — only the painting moves.
    expect(html).toContain('1\n2');
  });
});
