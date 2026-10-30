import { describe, expect, it } from 'vitest';
import type { AppMessage, Attachment, HostMessage } from '../../shared/protocol';
import { initialState, reducer } from './store';

const host = (message: HostMessage) => ({ type: 'host' as const, message });

const att = (id: string): Attachment => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  data: '',
  size: 10,
});

describe('reducer — host state messages', () => {
  it('leaves state untouched (same ref) for messages with no reducer case', () => {
    const next = reducer(
      initialState,
      host({ type: 'authStatus', status: { providers: [], path: '' } }),
    );
    expect(next).toBe(initialState);
  });

  it('applies runtimeStatus', () => {
    const next = reducer(
      initialState,
      host({ type: 'runtimeStatus', status: { phase: 'ready' } }),
    );
    expect(next.status.phase).toBe('ready');
  });

  it('applies models and config', () => {
    const models = [{ id: 'm', name: 'M', provider: 'p' }];
    expect(reducer(initialState, host({ type: 'models', models })).models).toEqual(
      models,
    );
    expect(
      reducer(
        initialState,
        host({ type: 'config', config: { thinkingLevel: 'high' } }),
      ).thinkingLevel,
    ).toBe('high');
  });

  it('derives streaming/compacting/thinkingLevel from session state', () => {
    const next = reducer(
      initialState,
      host({
        type: 'state',
        state: {
          model: null,
          thinkingLevel: 'low',
          isStreaming: true,
          isCompacting: false,
          steeringMode: '',
          followUpMode: '',
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      }),
    );
    expect(next.streaming).toBe(true);
    expect(next.compacting).toBe(false);
    expect(next.thinkingLevel).toBe('low');
  });

  it('marks history loaded on sessions', () => {
    const next = reducer(initialState, host({ type: 'sessions', sessions: [] }));
    expect(next.hasLoadedHistory).toBe(true);
  });
});

describe('reducer — history', () => {
  it('keeps only displayable roles, seeds tools, and rebuilds attachments', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
      },
      { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
      { role: 'tool', content: [] },
    ] as unknown as AppMessage[];

    const next = reducer(initialState, host({ type: 'history', messages }));

    // user + assistant kept; toolResult + tool filtered from the visible list
    expect(next.messages).toHaveLength(2);
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // tool seeded from the toolCall then completed by the toolResult
    expect(next.tools['t1'].toolName).toBe('bash');
    expect(next.tools['t1'].status).toBe('done');
    expect(next.tools['t1'].resultText).toBe('out');
  });
});

describe('reducer — streaming lifecycle (rpcEvent)', () => {
  it('toggles streaming and bumps seq on agent_start/agent_end', () => {
    let s = reducer(
      initialState,
      host({ type: 'rpcEvent', event: { type: 'agent_start' } }),
    );
    expect(s.streaming).toBe(true);
    s = reducer(s, host({ type: 'rpcEvent', event: { type: 'agent_end' } }));
    expect(s.streaming).toBe(false);
    expect(s.seq).toBe(1);
  });

  it('appends, updates, and finalizes an assistant message', () => {
    let s = reducer(
      initialState,
      host({
        type: 'rpcEvent',
        event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      }),
    );
    expect(s.messages).toHaveLength(1);
    expect(s.currentUid).not.toBeNull();
    expect(s.messages[0].streaming).toBe(true);

    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hello' }]);

    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        },
      }),
    );
    expect(s.messages[0].streaming).toBe(false);
    expect(s.currentUid).toBeNull();
  });

  it('survives message events that arrive without a payload', () => {
    // The runtime does emit these bare. Reading `.content` off the missing
    // message used to throw inside the reducer, which unmounted the whole view
    // and left the panel blank.
    let s = reducer(
      initialState,
      host({
        type: 'rpcEvent',
        event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      }),
    );
    const uid = s.currentUid;

    expect(() => {
      s = reducer(s, host({ type: 'rpcEvent', event: { type: 'message_update' } }));
    }).not.toThrow();
    // A payload-less update changes nothing and leaves the turn streaming.
    expect(s.currentUid).toBe(uid);
    expect(s.messages[0].streaming).toBe(true);

    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'message_update',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);

    // A payload-less end still has to finalize, keeping the content it had.
    expect(() => {
      s = reducer(s, host({ type: 'rpcEvent', event: { type: 'message_end' } }));
    }).not.toThrow();
    expect(s.messages[0].streaming).toBe(false);
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(s.currentUid).toBeNull();
  });

  it('ignores a message_start with no payload', () => {
    const s = reducer(
      initialState,
      host({ type: 'rpcEvent', event: { type: 'message_start' } }),
    );
    expect(s.messages).toHaveLength(0);
    expect(s.currentUid).toBeNull();
  });

  it('links pending attachments to a new user message', () => {
    let s = reducer(initialState, {
      type: 'addPendingAttachments',
      attachments: [att('a1')],
    });
    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: { type: 'message_start', message: { role: 'user', content: [] } },
      }),
    );
    expect(s.pendingAttachments).toHaveLength(0);
    expect(s.userAttachments.get(s.currentUid!)).toEqual([att('a1')]);
  });

  it('tracks a tool execution from start to end', () => {
    let s = reducer(
      initialState,
      host({
        type: 'rpcEvent',
        event: {
          type: 'tool_execution_start',
          toolCallId: 't1',
          toolName: 'bash',
          args: { command: 'ls' },
        },
      }),
    );
    expect(s.tools['t1'].status).toBe('running');
    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'done' }] },
          isError: false,
        },
      }),
    );
    expect(s.tools['t1'].status).toBe('done');
    expect(s.tools['t1'].resultText).toBe('done');
  });
});

describe('reducer — local UI actions', () => {
  it('adds then dismisses a pending extension-UI request', () => {
    const withUi = reducer(
      initialState,
      host({
        type: 'extensionUiRequest',
        request: { type: 'extension_ui_request', id: 'u1', method: 'confirm' },
      }),
    );
    expect(withUi.pendingUi).toHaveLength(1);
    const cleared = reducer(withUi, { type: 'dismissUi', id: 'u1' });
    expect(cleared.pendingUi).toHaveLength(0);
  });

  it('sets, adds, and clears pending attachments', () => {
    const set = reducer(initialState, {
      type: 'setPendingAttachments',
      attachments: [att('a1')],
    });
    expect(set.pendingAttachments).toHaveLength(1);
    const added = reducer(set, {
      type: 'addPendingAttachments',
      attachments: [att('a2')],
    });
    expect(added.pendingAttachments).toHaveLength(2);
    const cleared = reducer(added, { type: 'clearPendingAttachments' });
    expect(cleared.pendingAttachments).toHaveLength(0);
  });
});

describe('reducer — pi 1.4.0 wire shapes', () => {
  // Recorded from `pi --mode rpc` on a real run (tmp/rpc-probe.mjs). The shapes
  // that a block-array-only reducer used to reject: the system message carries a
  // string body, streaming arrives as deltas, and `message_update` has no
  // `message` snapshot at all.
  const event = (e: unknown) => host({ type: 'rpcEvent', event: e as never });

  it('ignores the leading system message and keeps its content out of the timeline', () => {
    // A string body used to land straight in UiMessage.content, and the timeline
    // then threw `content.forEach is not a function` and blanked the chat view.
    const s = reducer(
      initialState,
      event({
        type: 'message_start',
        message: { role: 'system', content: '', sections: { preamble: 'You are pi.' } },
      }),
    );
    expect(s.messages).toHaveLength(0);

    const afterEnd = reducer(s, event({ type: 'agent_start' }));
    expect(afterEnd.streaming).toBe(true);
  });

  it('normalizes a string-bodied user message through start and end', () => {
    let s = reducer(
      initialState,
      event({ type: 'message_start', message: { role: 'user', content: 'hi' } }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);

    s = reducer(
      s,
      event({ type: 'message_end', message: { role: 'user', content: 'hi' } }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(Array.isArray(s.messages[0].content)).toBe(true);
  });

  it('renders streamed text from assistantMessageEvent deltas', () => {
    let s = reducer(
      initialState,
      event({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    );
    s = reducer(
      s,
      event({
        type: 'message_update',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hel' },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(s.messages[0].streaming).toBe(true);

    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'Hello' }]);

    s = reducer(
      s,
      event({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          model: 'm',
        },
      }),
    );
    expect(s.messages[0].streaming).toBe(false);
    expect(s.messages[0].model).toBe('m');
  });

  it('drops system messages with no displayable content from history', () => {
    const s = reducer(
      initialState,
      host({
        type: 'history',
        messages: [
          { role: 'system', content: '' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
        ] as never,
      }),
    );
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('normalizes a tool result whose content is a plain string', () => {
    let s = reducer(initialState, event({ type: 'agent_start' }));
    s = reducer(
      s,
      event({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: { content: 'output text' },
        isError: false,
      }),
    );
    expect(s.tools.t1.resultBlocks).toEqual([
      { type: 'text', text: 'output text' },
    ]);
    expect(s.tools.t1.resultText).toBe('output text');
  });
});
