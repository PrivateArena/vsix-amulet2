import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolExec } from '../store';

// Chat components take hold of the VS Code API as they are imported; the suite has no webview.
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));
const { MdRender } = await import('./md-render');
const { CodeBlock } = await import('./code-block');
const { ExecBlock } = await import('./exec-view');
const { ReasoningBlock } = await import('./reasoning-block');
const { ChatCtx } = await import('../contexts/chat-context');
const { applyPrivacyConfig } = await import('../stores/privacy-store');

const SECRET = '/media/jang/home/PortableApp';
const SHOWN = '/media/user/home/PortableApp';

const config = (privacyMode: boolean) => ({
  expandThinking: false,
  preserveLineBreaks: true,
  notifySticky: false,
  privacyMode,
  privacyRules: [{ search: SECRET, replace: SHOWN }],
});

/** React complaints that are not this feature's business (SSR and layout effects). */
function markup(node: ReactElement): string {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // A thinking block reads the chat context, so everything is rendered inside it.
    return renderToStaticMarkup(<ChatCtx>{node}</ChatCtx>);
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

const bash: ToolExec = {
  toolCallId: 'b1',
  toolName: 'bash',
  args: { command: `ls ${SECRET}` },
  status: 'done',
  durationMs: 4,
  resultText: `${SECRET}/rustdesk`,
};

describe('Privacy mode in the transcript', () => {
  it('paints the censored text on every surface that shows the same string', () => {
    applyPrivacyConfig(config(true));
    const body = `Path is \`${SECRET}\`\n\n\`\`\`ts\nconst p = '${SECRET}';\n\`\`\``;
    expect(markup(<MdRender>{body}</MdRender>)).toContain(SHOWN);

    const code = markup(
      <CodeBlock code={`const p = '${SECRET}';`} path="a.ts" />,
    );
    expect(code).toContain(SHOWN);

    const thinking = markup(<ReasoningBlock text={`looked in ${SECRET}`} />);
    expect(thinking).toContain(SHOWN);

    const card = markup(<ExecBlock name="bash" args={bash.args} tool={bash} />);
    // header preview, streamed command body, result block and the copy button's text
    expect(card).not.toContain('jang');
    expect(card).toContain(SHOWN);
  });

  it('paints the original text while the switch is off', () => {
    applyPrivacyConfig(config(false));
    expect(markup(<MdRender>{`see ${SECRET}`}</MdRender>)).toContain(SECRET);
    const card = markup(<ExecBlock name="bash" args={bash.args} tool={bash} />);
    expect(card).toContain(SECRET);
  });
});
