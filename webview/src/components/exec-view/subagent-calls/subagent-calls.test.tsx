import { renderToStaticMarkup } from 'react-dom/server';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import type { ToolExec } from '../../../store';

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: () => {},
  getState: () => undefined,
  setState: () => {},
}));

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
const { SubagentCalls } = await import('./subagent-calls');

/** What the reducer would hold for a nested call. */
function nested(over: Partial<ToolExec>): ToolExec {
  return {
    toolCallId: over.toolCallId ?? 'P/1',
    toolName: 'bash',
    args: { command: 'make world' },
    status: 'done',
    startedAt: 1,
    ...over,
  } as ToolExec;
}

function body(props: Parameters<typeof SubagentCalls>[0]): string {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return renderToStaticMarkup(<SubagentCalls {...props} />);
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

describe('subagent card body', () => {
  beforeEach(() => {
    Object.assign(chat, { streaming: false, bridge: { available: false } });
  });

  it('gives every nested call its own copy control', () => {
    const html = body({
      toolCallId: 'P',
      status: 'running',
      details: { status: 'running' },
      calls: [
        nested({
          toolCallId: 'P/1',
          toolName: 'bash',
          args: { command: 'make world' },
        }),
        nested({
          toolCallId: 'P/2',
          toolName: 'read',
          args: { path: 'a/b.ts' },
        }),
      ],
      tools: {},
    });
    // A row is a control that repeats, so it is addressed by class and never by `id`.
    expect(html.match(/ctl-row-copy/g)?.length).toBe(2);
    expect(html).toContain('Copy the command');
    expect(html).toContain('Copy the path');
    expect(html).not.toContain('id="ctl-row-copy"');
  });

  it('offers no copy control for a call with nothing to copy', () => {
    const html = body({
      toolCallId: 'P',
      status: 'running',
      details: { status: 'running' },
      calls: [nested({ args: {} })],
      tools: {},
    });
    expect(html).not.toContain('ctl-row-copy');
  });

  it('states the live phase in the footer, in its own tone', () => {
    const html = body({
      toolCallId: 'P',
      status: 'running',
      details: {
        status: 'running',
        phase: 'finalReport',
        title: 'Explore',
        turns: 4,
      },
      calls: [],
      tools: {},
    });
    expect(html).toContain('Writing the final report…');
    expect(html).toContain('sub-agent-state is-report');
    expect(html).toContain('Explore · 4 turns');
  });

  it('shows what the child thought, newest first on screen', () => {
    const html = body({
      toolCallId: 'P',
      status: 'running',
      details: {
        status: 'running',
        phase: 'calling',
        activity: 'bash',
        reasoning: [
          { turn: 1, text: 'First, look at the tree.' },
          { turn: 2, text: 'Now read the manifest.' },
        ],
        reasoningTruncated: true,
      },
      calls: [],
      tools: {},
    });
    expect(html).toContain('sub-agent-thinking');
    expect(html).toContain('Turn 1');
    expect(html).toContain('Turn 2');
    // The newest thought is the one being watched, so it is the one left open under SSR defaults.
    expect(html).toContain('Now read the manifest.');
    expect(html).toContain('the transcript holds all of it');
  });

  it('omits the thinking section when the runtime reports none', () => {
    const html = body({
      toolCallId: 'P',
      status: 'done',
      details: { status: 'completed', exit: 'done', report: 'Two files.' },
      calls: [],
      report: 'Two files.',
      tools: {},
    });
    expect(html).not.toContain('sub-agent-thinking');
    expect(html).toContain('sub-agent-state is-done');
  });

  it('offers the transcript only when the runtime named one', () => {
    const withLog = body({
      toolCallId: 'P',
      status: 'done',
      details: {
        status: 'completed',
        exit: 'done',
        childSessionFile: '/home/u/.pi/…/subagent/a.jsonl',
      },
      calls: [],
      tools: {},
    });
    expect(withLog).toContain('ctl-subagent-log');
    expect(withLog).toContain('Open the subagent transcript');

    const withoutLog = body({
      toolCallId: 'P',
      status: 'done',
      details: { status: 'completed', exit: 'done' },
      calls: [],
      tools: {},
    });
    expect(withoutLog).not.toContain('ctl-subagent-log');
  });
});
