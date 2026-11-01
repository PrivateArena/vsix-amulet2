import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolExec } from '../../store';

// Every chat component reaches the host boundary through `apis/actions`, and that module
// takes hold of the VS Code API as it is imported. The suite has no webview, so hand it a
// inert one before the card is loaded.
vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));
const { ExecBlock } = await import('./tool-call-view');

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
    expect(html.indexOf('exec-write-caret')).toBeGreaterThan(
      html.indexOf('the body is'),
    );
  });

  it('folds the head of a long body away rather than losing the tail', () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\\n');
    const html = card({
      name: 'write',
      partialArgs: `{"path":"big.ts","content":"${body}"}`,
    });
    expect(html).toContain('… 16 earlier lines …');
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
    expect(html).toContain('exec-write-caret');
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
    expect(html).not.toContain('exec-write-caret');
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
    expect(html).not.toContain('exec-write-caret');
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
