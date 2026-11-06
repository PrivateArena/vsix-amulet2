import { renderToStaticMarkup } from 'react-dom/server';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { ToolExec } from '../../store';

// Every chat component reaches the host boundary through `apis/actions`, and that module
// takes hold of the VS Code API as it is imported. The suite has no webview, so hand it a
// inert one before the card is loaded.
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));

/**
 * The card's context menu reads the shared chat state (availability, streaming, the live record of the
 * call), and this suite has no provider. A hoisted mutable fake is enough: nothing here dispatches, and
 * a test that wants a badge or an enabled menu sets the fields it cares about first.
 */
const { chat } = vi.hoisted(() => ({
  chat: {
    streaming: false,
    bridge: { available: false },
    tools: {},
  } as unknown as Record<string, unknown>,
}));
vi.mock('../../contexts/chat-context', () => ({
  useChatState: () => chat,
  useChatDispatch: () => () => {},
  useReady: () => true,
}));
const { ExecBlock } = await import('./tool-call-view');

/** What the reducer would hold for a card under test. */
function setState(over: Record<string, unknown>): void {
  Object.assign(chat, over);
}

/**
 * Render-time checks for the streaming tool card. They run through `react-dom/server`
 * because the suite has no DOM — enough to prove what the card puts on screen for a call
 * whose arguments are still arriving, which is what the reducer hands it.
 */
function card(props: Parameters<typeof ExecBlock>[0]): string {
  // SSR says so itself: a layout effect cannot run there, and `useStickToBottom` has one.
  // Anything else React complains about is a real failure, so it still reaches the report.
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(<ExecBlock {...props} />);
  } finally {
    const reported = errors.mock.calls.map(([message]) => String(message));
    errors.mockRestore();
    // Everything but the SSR note is a real failure, so it goes back out.
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

const STREAMED = '{"path":"notes/a.md","content":"# Title\\n\\nthe body is';

describe('write card while the arguments stream', () => {
  it('shows the body and the line count before the runtime reports the call', () => {
    const html = card({ name: 'write', partialArgs: STREAMED });
    expect(html).toContain('exec-write-stream');
    expect(html).toContain('notes/a.md');
    expect(html).toContain('# Title');
    expect(html).toContain('the body is');
    expect(html).toContain('+3 lines');
    // The newest line is the one carrying the caret, so the stream reads as typing.
    expect(html.indexOf('exec-stream-caret')).toBeGreaterThan(
      html.indexOf('the body is'),
    );
  });

  it('folds the head of a long body away rather than losing the tail', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\\n');
    const html = card({
      name: 'write',
      partialArgs: `{"path":"big.ts","content":"${body}"}`,
    });
    expect(html).toContain('… 24 earlier lines …');
    expect(html).toContain('line 39');
    expect(html).not.toContain('>+ line 0<');
    expect(html).toContain('+40 lines');
  });

  it('has something to say before the body starts', () => {
    const html = card({
      name: 'write',
      partialArgs: '{"path":"a.ts","content":"',
    });
    expect(html).toContain('a.ts');
    expect(html).toContain('Writing content…');
    expect(html).not.toContain('exec-write-counts');
  });

  it('shows a whole file at once for a provider that does not stream arguments', () => {
    // Google sends the entire object as a single delta: the preview still has to read as a
    // call in flight, not as one that already ran.
    const html = card({
      name: 'write',
      partialArgs: '{"path":"a.md","content":"one\\ntwo"}',
    });
    expect(html).toContain('exec-write-stream');
    expect(html).toContain('+2 lines');
    expect(html).toContain('exec-stream-caret');
  });

  it('shows the body even when the model typed it before the path', () => {
    const html = card({ name: 'write', partialArgs: '{"content":"hello wor' });
    expect(html).toContain('hello wor');
    expect(html).not.toContain('exec-summary-text');
  });

  it('settles into the finished patch once the call has run', () => {
    const args = { path: 'a.md', content: 'x\ny\n' };
    const tool: ToolExec = {
      toolCallId: 'w1',
      toolName: 'write',
      args,
      status: 'done',
      durationMs: 4,
      resultText: 'Successfully wrote to a.md',
    };
    const html = card({ name: 'write', args, tool });
    expect(html).toContain('patch-additions-only');
    expect(html).not.toContain('exec-write-stream');
    expect(html).not.toContain('exec-stream-caret');
    expect(html).toContain('+2 lines');
  });

  it('counts nothing for a write that failed', () => {
    const args = { path: 'a.md', content: 'x\ny\n' };
    const html = card({
      name: 'write',
      args,
      tool: {
        toolCallId: 'w1',
        toolName: 'write',
        args,
        status: 'error',
        isError: true,
        resultText: 'EACCES: permission denied',
      },
    });
    expect(html).not.toContain('exec-write-counts');
    expect(html).toContain('EACCES: permission denied');
  });

  it('renders no stream for a call the runtime never reported', () => {
    // An aborted reply keeps no buffer, so this card is a stale tool call: inert, not a
    // preview pretending to type.
    const html = card({ name: 'write' });
    expect(html).not.toContain('exec-write-stream');
    expect(html).not.toContain('exec-stream-caret');
  });
});

describe('card while a call is still being typed', () => {
  it('says typing rather than running while the arguments arrive', () => {
    const html = card({ name: 'bash', partialArgs: '{"command":"wc -l tm' });
    expect(html).toContain('wc -l tm');
    expect(html).toContain('Typing…');
    expect(html).not.toContain('Running…');
  });

  it('keeps the diff off screen until the replacement is finished', () => {
    // Two edits, the second still being typed: the first is closed and honest, but a diff
    // that changes shape as the model types is worse than the wait.
    const typing = card({
      name: 'edit',
      partialArgs:
        '{"path":"a.ts","edits":[{"oldText":"x","newText":"y"},{"oldText":"z"',
    });
    expect(typing).toContain('Writing replacement…');
    expect(typing).not.toContain('patch-line-del');

    const typed = card({
      name: 'edit',
      args: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] },
    });
    expect(typed).toContain('patch-line-del');
    expect(typed).toContain('patch-line-add');
  });

  it('offers no half-typed value to the copy button', () => {
    const html = card({ name: 'write', partialArgs: STREAMED });
    expect(html).not.toContain('Copy the path');
  });
});

describe('terminal card while the command streams', () => {
  /** A heredoc: the head of the command, then `count` lines of body. */
  const heredocLines = (count: number) => [
    "cat >> a.go << 'EOF'",
    ...Array.from({ length: count }, (_, i) => `echo ${i}`),
  ];

  /** The same as the argument buffer the model has typed so far. */
  const typedHeredoc = (count: number) =>
    `{"command":"${heredocLines(count).join('\\n')}`;

  it('shows the command in the followed box, prompt and caret and all', () => {
    const html = card({ name: 'bash', partialArgs: '{"command":"wc -l src"' });
    expect(html).toContain('exec-cmd-stream');
    expect(html).toContain('$ wc -l src');
    expect(html).toContain('Typing…');
    // The newest line is the one carrying the caret, so the stream reads as typing.
    expect(html.indexOf('exec-stream-caret')).toBeGreaterThan(
      html.indexOf('wc -l src'),
    );
  });

  it('folds the head of a heredoc away rather than losing its tail', () => {
    const html = card({ name: 'bash', partialArgs: typedHeredoc(40) });
    // The window is what the box holds, whatever the size of the heredoc.
    expect(html).toContain('… 29 earlier lines …');
    expect(html).toContain('>echo 28<');
    expect(html).toContain('echo 39');
    expect(html).not.toContain('>echo 27<');
    // And the header still names the command the window starts below.
    expect(html).toContain('cat &gt;&gt; a.go');
  });

  it('reads the command from its head once the model has typed it', () => {
    // The runtime has the call now, so nothing about the command is moving any more: the window
    // and its caret are retired, and the output that arrives next is what the card follows.
    const command = heredocLines(40).join('\n');
    const html = card({
      name: 'bash',
      tool: {
        toolCallId: 'b1',
        toolName: 'bash',
        args: { command },
        status: 'running',
        startedAt: Date.now(),
      },
    });
    expect(html).not.toContain('exec-cmd-stream');
    expect(html).toContain('exec-bash');
    expect(html).toContain('$ cat');
    expect(html).toContain('Running…');
  });

  it('follows the output of a call that is running', () => {
    // pi streams a running `bash`'s output on `tool_execution_update`; the card body is what
    // holds it, and the card follows it there (`scroller`) until the reader takes the scroll.
    const html = card({
      name: 'bash',
      tool: {
        toolCallId: 'b1',
        toolName: 'bash',
        args: { command: 'go test ./...' },
        status: 'running',
        startedAt: Date.now(),
        resultText: 'ok  internal/foo\n',
      },
    });
    expect(html).toContain('$ go test ./...');
    expect(html).toContain('exec-bash-out');
    expect(html).toContain('ok  internal/foo');
    expect(html).not.toContain('Running…');
  });

  it('reads a command that has run from its head', () => {
    const command = heredocLines(40).join('\n');
    const html = card({
      name: 'bash',
      args: { command },
      tool: {
        toolCallId: 'b1',
        toolName: 'bash',
        args: { command },
        status: 'done',
        durationMs: 12,
        resultText: '',
      },
    });
    expect(html).not.toContain('exec-cmd-stream');
    expect(html).toContain('exec-bash');
    expect(html).toContain('$ cat');
    expect(html).toContain('\necho 0\n');
  });
});

const IMAGE_REF = {
  path: '/tmp/zen-cap/screenshot.png',
  mimeType: 'image/png',
  bytes: 4096,
};

describe('read card line window', () => {
  const readTool = (args: Record<string, unknown>): ToolExec => ({
    toolCallId: 'r1',
    toolName: 'read',
    args: { path: '/a/b/watch_test.go', ...args },
    status: 'done',
    durationMs: 8,
    resultText: 'func TestWatch(t *testing.T) {',
  });

  it('names the lines a partial read covered', () => {
    const html = card({
      name: 'read',
      tool: readTool({ offset: 120, limit: 42 }),
    });
    // The header shortens the path but keeps the window, which is what says what the card
    // covers; the tooltip carries the path in full and still ends with it.
    expect(html).toContain('watch_test.go:120-161');
    expect(html).toContain('title="/a/b/watch_test.go:120-161"');
    // The code body reads its highlight language from the bare path, not from the suffixed one.
    expect(html).toContain('language-go');
  });

  it('says nothing about a read of the whole file', () => {
    const html = card({ name: 'read', tool: readTool({}) });
    expect(html).toContain('>watch_test.go<');
    expect(html).not.toContain('watch_test.go:');
  });

  it('shows the window as soon as the model has typed it', () => {
    const html = card({
      name: 'read',
      partialArgs: '{"path":"notes/a.md","offset":16,"limit":8}',
    });
    expect(html).toContain('a.md:16-23');
  });
});

describe('read card for an image', () => {
  const imageTool = (patch: Partial<ToolExec> = {}): ToolExec => ({
    toolCallId: 'r1',
    toolName: 'read',
    args: { path: IMAGE_REF.path },
    status: 'done',
    durationMs: 12,
    resultText: 'Read image file [image/png]',
    images: [IMAGE_REF],
    ...patch,
  });

  it('shows a waiting tile rather than an image while the bytes stay on disk', () => {
    const html = card({ name: 'read', tool: imageTool() });
    expect(html).toContain('exec-image-state');
    expect(html).toContain('screenshot.png');
    expect(html).not.toContain('<img');
    // pi's own note survives as the caption, not as a code block.
    expect(html).toContain('exec-read-note');
    expect(html).toContain('Read image file [image/png]');
  });

  it('renders the delivered pixels and marks the card as one holding an image', () => {
    const html = card({
      name: 'read',
      tool: imageTool({
        images: [
          { ...IMAGE_REF, dataUrl: 'data:image/png;base64,QUJD', size: 3 },
        ],
      }),
    });
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).toContain('exec-has-image');
    expect(html).toContain('exec-image-zoom');
    expect(html).not.toContain('exec-image-state');
  });

  it('says why the host could not read the file', () => {
    const html = card({
      name: 'read',
      tool: imageTool({
        images: [
          { ...IMAGE_REF, error: 'no file at /tmp/zen-cap/screenshot.png' },
        ],
      }),
    });
    expect(html).toContain('exec-image-state');
    expect(html).toContain('no file at');
    expect(html).not.toContain('<img');
  });

  it('describes an image that never came from a file', () => {
    const html = card({
      name: 'read',
      tool: imageTool({ images: [{ ...IMAGE_REF, path: undefined }] }),
    });
    expect(html).toContain('no file to read');
  });

  it('keeps a failed read as the error text it is', () => {
    const html = card({
      name: 'read',
      tool: imageTool({ status: 'error', isError: true, resultText: 'ENOENT' }),
    });
    expect(html).toContain('exec-output-error');
    expect(html).toContain('ENOENT');
  });
});

describe('card context menu and badge', () => {
  const ctxTool = (over: Partial<ToolExec> = {}): ToolExec => ({
    toolCallId: 'call_ctx',
    toolName: 'read',
    status: 'done',
    resultText: 'the output the model may stop reading',
    ...over,
  });

  const live = (tool: ToolExec, bridge = true) =>
    setState({
      streaming: false,
      bridge: { available: bridge },
      tools: { [tool.toolCallId]: tool },
    });

  beforeEach(() => {
    setState({ streaming: false, bridge: { available: false }, tools: {} });
  });

  it('marks the card with the call id the menu needs to address it', () => {
    const tool = ctxTool();
    live(tool);
    expect(card({ name: 'read', tool })).toContain(
      'data-tool-call-id="call_ctx"',
    );
  });

  it('offers nothing where the bridge is not loaded', () => {
    const tool = ctxTool();
    card({ name: 'read', tool });
    setState({
      bridge: { available: false },
      tools: { [tool.toolCallId]: tool },
    });
    expect(card({ name: 'read', tool })).not.toContain('exec-ctx-trigger');
  });

  it('offers the group when the runtime can honour it', () => {
    const tool = ctxTool();
    live(tool);
    const html = card({ name: 'read', tool });
    expect(html).toContain('exec-ctx-trigger');
    expect(html).toContain('aria-haspopup="menu"');
    // The menu itself is anchored on click, so it is not in the markup of a static render.
    expect(html).not.toContain('ctx-menu');
  });

  it('badges an omitted result and says what it means', () => {
    const tool = ctxTool({ ctxEdit: { kind: 'omitted' } });
    live(tool);
    const html = card({ name: 'read', tool });
    expect(html).toContain('exec-ctx-badge');
    expect(html).toContain('Omitted from context');
    // The card still paints the real output — the badge is about the model, not about the transcript.
    expect(html).toContain('the output the model may');
  });

  it('badges a replacement apart from an omission, and a refusal apart from both', () => {
    const replaced = ctxTool({
      ctxEdit: { kind: 'replaced', replacementText: 'edited text' },
    });
    live(replaced);
    expect(card({ name: 'read', tool: replaced })).toContain(
      'Edited in context',
    );

    const failed = ctxTool({
      ctxEdit: { kind: 'failed', error: 'pi is working' },
    });
    live(failed);
    const html = card({ name: 'read', tool: failed });
    expect(html).toContain('Could not edit');
    expect(html).toContain('is-failed');
    expect(html).not.toContain('Omitted from context');
  });

  it('shows no badge for a card the model still reads as written', () => {
    live(ctxTool());
    expect(card({ name: 'read', tool: ctxTool() })).not.toContain(
      'exec-ctx-badge',
    );
  });
});
