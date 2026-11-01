import { describe, expect, it } from 'vitest';
import type {
  AppMessage,
  Attachment,
  HostMessage,
} from '../../shared/protocol';
import { asToolCall } from '../../shared/blocks';
import { parseStreamingToolArgs } from '../../shared/tool-args';
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
    expect(
      reducer(initialState, host({ type: 'models', models })).models,
    ).toEqual(models);
    expect(
      reducer(
        { ...initialState, expandThinking: true },
        host({ type: 'config', config: { expandThinking: false } }),
      ).expandThinking,
    ).toBe(false);
  });

  it('applies the thinking levels reported by the runtime', () => {
    const next = reducer(
      initialState,
      host({ type: 'thinkingLevels', levels: ['off', 'low', 'xhigh'] }),
    );
    expect(next.thinkingLevels).toEqual(['off', 'low', 'xhigh']);
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

  it('keeps thinkingLevel null when the runtime has none applied', () => {
    const next = reducer(
      { ...initialState, thinkingLevel: 'medium' },
      host({
        type: 'state',
        state: {
          model: null,
          isStreaming: false,
          isCompacting: false,
          steeringMode: '',
          followUpMode: '',
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      }),
    );
    expect(next.thinkingLevel).toBeNull();
  });

  it('tracks thinking_level_changed events (cycle command / extensions)', () => {
    const event = { type: 'thinking_level_changed', level: 'xhigh' };
    const state = {
      ...initialState,
      session: {
        model: null,
        thinkingLevel: 'low' as const,
        isStreaming: false,
        isCompacting: false,
        steeringMode: '',
        followUpMode: '',
        autoCompactionEnabled: false,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    };
    const next = reducer(state, host({ type: 'rpcEvent', event }));
    expect(next.thinkingLevel).toBe('xhigh');
    // The cached session is kept in step, so nothing renders a stale level.
    expect(next.session?.thinkingLevel).toBe('xhigh');
    expect(
      reducer(
        state,
        host({ type: 'rpcEvent', event: { type: 'queue_update' } }),
      ),
    ).toBe(state);
  });

  it('marks history loaded on sessions', () => {
    const next = reducer(
      initialState,
      host({ type: 'sessions', sessions: [] }),
    );
    expect(next.hasLoadedHistory).toBe(true);
  });
});

describe('reducer — history', () => {
  it('keeps only displayable roles, seeds tools, and rebuilds attachments', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 't1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'out' }],
      },
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
        event: {
          type: 'message_start',
          message: { role: 'assistant', content: [] },
        },
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
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
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
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
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
        event: {
          type: 'message_start',
          message: { role: 'assistant', content: [] },
        },
      }),
    );
    const uid = s.currentUid;

    expect(() => {
      s = reducer(
        s,
        host({ type: 'rpcEvent', event: { type: 'message_update' } }),
      );
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
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);

    // A payload-less end still has to finalize, keeping the content it had.
    expect(() => {
      s = reducer(
        s,
        host({ type: 'rpcEvent', event: { type: 'message_end' } }),
      );
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
        event: {
          type: 'message_start',
          message: { role: 'user', content: [] },
        },
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
    // The live elapsed badge needs the start time, and has to survive the events
    // that rebuild the entry while the call runs.
    const startedAt = s.tools['t1'].startedAt!;
    expect(startedAt).toBeTypeOf('number');
    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'tool_execution_update',
          toolCallId: 't1',
          toolName: 'bash',
          partialResult: { content: [{ type: 'text', text: 'a' }] },
        },
      }),
    );
    expect(s.tools['t1'].startedAt).toBe(startedAt);
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
    // pi omits `durationMs` for a call it did not run, so the measured span of the
    // live counter is the fallback — the badge must not vanish on completion.
    expect(s.tools['t1'].durationMs).toBeTypeOf('number');
  });

  it('keeps the duration pi reported', () => {
    let s = reducer(
      initialState,
      host({
        type: 'rpcEvent',
        event: {
          type: 'tool_execution_start',
          toolCallId: 't2',
          toolName: 'bash',
          args: { command: 'pnpm run build' },
        },
      }),
    );
    s = reducer(
      s,
      host({
        type: 'rpcEvent',
        event: {
          type: 'tool_execution_end',
          toolCallId: 't2',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'built' }] },
          durationMs: 9400,
        },
      }),
    );
    expect(s.tools['t2'].durationMs).toBe(9400);
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

  it('queues extension-UI requests in arrival order (pi-gate asks follow-ups per stage)', () => {
    let state = reducer(
      initialState,
      host({
        type: 'extensionUiRequest',
        request: { type: 'extension_ui_request', id: 'q1', method: 'select' },
      }),
    );
    state = reducer(
      state,
      host({
        type: 'extensionUiRequest',
        request: { type: 'extension_ui_request', id: 'q2', method: 'input' },
      }),
    );
    // The prompt renders pendingUi[0]; dismissing it must reveal the next question, not drop it.
    expect(state.pendingUi.map((u) => u.id)).toEqual(['q1', 'q2']);
    state = reducer(state, { type: 'dismissUi', id: 'q1' });
    expect(state.pendingUi.map((u) => u.id)).toEqual(['q2']);
  });

  it('drops pending extension-UI dialogs when the runtime goes away', () => {
    const withUi = reducer(
      initialState,
      host({
        type: 'runtimeStatus',
        status: { phase: 'ready' },
      }),
    );
    const open = reducer(
      withUi,
      host({
        type: 'extensionUiRequest',
        request: { type: 'extension_ui_request', id: 'd1', method: 'select' },
      }),
    );
    expect(open.pendingUi).toHaveLength(1);
    // A restart or crash kills the child that asked, so nobody can answer it any more.
    for (const phase of ['starting', 'stopped', 'error'] as const) {
      const next = reducer(
        open,
        host({ type: 'runtimeStatus', status: { phase } }),
      );
      expect(next.pendingUi).toEqual([]);
    }
    // `ready` keeps questions that are still live on the current child.
    const alive = reducer(
      open,
      host({ type: 'runtimeStatus', status: { phase: 'ready' } }),
    );
    expect(alive.pendingUi).toHaveLength(1);
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
        message: {
          role: 'system',
          content: '',
          sections: { preamble: 'You are pi.' },
        },
      }),
    );
    expect(s.messages).toHaveLength(0);

    const afterEnd = reducer(s, event({ type: 'agent_start' }));
    expect(afterEnd.streaming).toBe(true);
  });

  it('normalizes a string-bodied user message through start and end', () => {
    let s = reducer(
      initialState,
      event({
        type: 'message_start',
        message: { role: 'user', content: 'hi' },
      }),
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
      event({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'message_update',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {},
        },
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Hel',
        },
      }),
    );
    expect(s.messages[0].content).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(s.messages[0].streaming).toBe(true);

    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'lo',
        },
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
describe('reducer — a streamed write call', () => {
  // `pi --mode rpc` finalizes a call's arguments at `toolcall_end` and never reports a
  // partial write, so the card's live preview depends entirely on the deltas the reducer
  // folds into the block. Recorded shape, one delta per streamed JSON fragment.
  const event = (e: unknown) => host({ type: 'rpcEvent', event: e as never });
  const fragments = [
    '{"path":"notes/a.md","content":"# Tit',
    'le\\n\\nbody',
    '"}',
  ];
  const finalCall = {
    type: 'toolCall',
    id: 'w1',
    name: 'write',
    arguments: { path: 'notes/a.md', content: '# Title\n\nbody' },
  };

  it('buffers the argument text, then hands the card to the runtime', () => {
    let s = reducer(
      initialState,
      event({
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 0,
          id: 'w1',
          toolName: 'write',
        },
      }),
    );

    const streamed = s.messages[0].content.map(asToolCall)[0];
    expect(streamed).toMatchObject({ id: 'w1', name: 'write' });
    expect(s.tools).toEqual({});

    let buffer = '';
    for (const delta of fragments) {
      buffer += delta;
      s = reducer(
        s,
        event({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_delta',
            contentIndex: 0,
            delta,
          },
        }),
      );
      expect(asToolCall(s.messages[0].content[0])?.partialArgs).toBe(buffer);
    }

    // Mid-stream the call is displayable but not yet valid: the card reads the buffer.
    const partial = asToolCall(s.messages[0].content[0]);
    expect(partial?.arguments).toBeUndefined();
    expect(parseStreamingToolArgs(partial?.partialArgs)).toEqual({
      path: 'notes/a.md',
      content: '# Title\n\nbody',
    });

    s = reducer(
      s,
      event({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: finalCall,
        },
      }),
    );
    expect(asToolCall(s.messages[0].content[0])).toEqual(finalCall);

    s = reducer(
      s,
      event({
        type: 'message_end',
        message: { role: 'assistant', content: [finalCall] },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'tool_execution_start',
        toolCallId: 'w1',
        toolName: 'write',
        args: finalCall.arguments,
      }),
    );
    expect(s.tools.w1).toMatchObject({ status: 'running', toolName: 'write' });

    s = reducer(
      s,
      event({
        type: 'tool_execution_end',
        toolCallId: 'w1',
        toolName: 'write',
        durationMs: 4,
        result: {
          content: [{ type: 'text', text: 'Successfully wrote to notes/a.md' }],
        },
      }),
    );
    expect(s.tools.w1).toMatchObject({
      status: 'done',
      resultText: 'Successfully wrote to notes/a.md',
    });
  });
});

describe('reducer — nested (subagent) tool calls', () => {
  // Recorded from `pi --mode rpc` with a real subagent run (scripts/rpc-probe.mjs).
  // A tool that calls `ctx.executeTool()` emits ordinary `tool_execution_*` events
  // for each nested call, tagged with `parentToolCallId` and an id of
  // `<parentToolCallId>/<n>`; the child produces no messages of its own.
  const event = (e: unknown) => host({ type: 'rpcEvent', event: e as never });

  const PARENT = 'call_sub';
  const start = {
    type: 'tool_execution_start',
    toolCallId: PARENT,
    toolName: 'subagent',
    args: {
      role: 'explore',
      task: 'Survey the directory and describe each file.',
    },
  };
  const nestedStart = (n: number, command: string) => ({
    type: 'tool_execution_start',
    toolCallId: `${PARENT}/${n}`,
    toolName: 'bash',
    args: { command },
    parentToolCallId: PARENT,
  });

  it('hangs nested calls off the calling tool, in arrival order', () => {
    let s = reducer(initialState, event(start));
    s = reducer(s, event(nestedStart(1, 'ls -la /tmp/probe-ws')));
    s = reducer(s, event(nestedStart(2, 'find /tmp/probe-ws -maxdepth 3')));

    expect(s.tools[PARENT].childIds).toEqual([`${PARENT}/1`, `${PARENT}/2`]);
    expect(s.tools[`${PARENT}/1`]).toMatchObject({
      toolName: 'bash',
      parentToolCallId: PARENT,
      status: 'running',
      args: { command: 'ls -la /tmp/probe-ws' },
    });
    // A nested event must not disturb the parent's own entry.
    expect(s.tools[PARENT]).toMatchObject({
      toolName: 'subagent',
      status: 'running',
      args: start.args,
    });
  });

  it('settles a nested call with its result and duration, then the parent with its report', () => {
    let s = reducer(initialState, event(start));
    s = reducer(s, event(nestedStart(1, 'ls -la /tmp/probe-ws')));
    s = reducer(
      s,
      event({
        type: 'tool_execution_update',
        toolCallId: `${PARENT}/1`,
        toolName: 'bash',
        parentToolCallId: PARENT,
        partialResult: {
          content: [{ type: 'text', text: 'total 12\nprobe.log' }],
        },
      }),
    );
    s = reducer(
      s,
      event({
        type: 'tool_execution_end',
        toolCallId: `${PARENT}/1`,
        toolName: 'bash',
        parentToolCallId: PARENT,
        result: { content: [{ type: 'text', text: 'total 12\nprobe.log' }] },
        isError: false,
        durationMs: 6,
      }),
    );
    expect(s.tools[`${PARENT}/1`]).toMatchObject({
      status: 'done',
      durationMs: 6,
      resultText: 'total 12\nprobe.log',
    });
    // The parent's live progress heartbeat carries the card metadata.
    s = reducer(
      s,
      event({
        type: 'tool_execution_update',
        toolCallId: PARENT,
        toolName: 'subagent',
        partialResult: {
          content: [{ type: 'text', text: 'subagent running · turn 2' }],
          details: {
            status: 'running',
            role: 'explore',
            displayName: 'Explore',
            turns: 2,
            toolCalls: 3,
            activity: 'bash',
            elapsedMs: 14863,
            pendant: { title: 'Explore', subtitle: 'Survey the directory.' },
          },
        },
      }),
    );
    expect((s.tools[PARENT].details as { elapsedMs?: number })?.elapsedMs).toBe(
      14863,
    );

    s = reducer(
      s,
      event({
        type: 'tool_execution_end',
        toolCallId: PARENT,
        toolName: 'subagent',
        result: {
          content: [
            { type: 'text', text: '[subagent explore · DONE]\n\nTwo files.' },
          ],
          details: { status: 'completed', exit: 'done', report: 'Two files.' },
        },
        isError: false,
        durationMs: 13000,
      }),
    );
    expect(s.tools[PARENT]).toMatchObject({
      status: 'done',
      durationMs: 13000,
      // the list built while it ran survives the end event
      childIds: [`${PARENT}/1`],
    });
    expect((s.tools[PARENT].details as { report?: string })?.report).toBe(
      'Two files.',
    );
  });

  it('records a truncated nested-call list from the settled tool result', () => {
    let s = reducer(initialState, event(start));
    s = reducer(s, event(nestedStart(1, 'ls')));
    s = reducer(
      s,
      event({
        type: 'message_start',
        message: {
          role: 'toolResult',
          toolCallId: PARENT,
          toolName: 'subagent',
          content: [{ type: 'text', text: 'Two files.' }],
          nestedCalls: {
            calls: [{ id: `${PARENT}/1`, name: 'bash', status: 'ok' }],
            complete: false,
          },
        },
      }),
    );
    expect(s.tools[PARENT].nestedComplete).toBe(false);
    // A tool result with no nested record leaves the map alone.
    const untouched = reducer(
      s,
      event({
        type: 'message_start',
        message: { role: 'toolResult', toolCallId: 'other', content: 'x' },
      }),
    );
    expect(untouched.tools).toBe(s.tools);
  });

  it('rebuilds the nested list, details and omitted arguments from history', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: PARENT,
            name: 'subagent',
            arguments: { task: 'Survey' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: PARENT,
        toolName: 'subagent',
        content: [{ type: 'text', text: 'Two files.' }],
        durationMs: 13000,
        details: { status: 'completed', report: 'Two files.' },
        nestedCalls: {
          calls: [
            {
              id: `${PARENT}/1`,
              name: 'bash',
              status: 'ok',
              arguments: { command: 'ls -la' },
              durationMs: 6,
            },
            {
              id: `${PARENT}/2`,
              name: 'read',
              status: 'error',
              argumentsBytes: 40000,
              error: 'EISDIR',
            },
            { id: `${PARENT}/3`, name: 'bash', status: 'unfinished' },
          ],
          complete: false,
        },
      },
    ] as unknown as AppMessage[];

    const s = reducer(initialState, host({ type: 'history', messages }));

    expect(s.tools[PARENT]).toMatchObject({
      status: 'done',
      durationMs: 13000,
      childIds: [`${PARENT}/1`, `${PARENT}/2`, `${PARENT}/3`],
      nestedComplete: false,
    });
    expect(s.tools[`${PARENT}/1`]).toMatchObject({
      status: 'done',
      durationMs: 6,
      args: { command: 'ls -la' },
    });
    expect(s.tools[`${PARENT}/2`]).toMatchObject({
      status: 'error',
      argsOmittedBytes: 40000,
      // pi's record keeps the error text of a failed nested call, and that is the one
      // output a reloaded row can expand to.
      resultText: 'EISDIR',
    });
    expect(s.tools[`${PARENT}/1`].resultText).toBeUndefined();
    // Marks the list as record-built, which is what tells the card its rows have no
    // outputs to show.
    expect(s.tools[PARENT].nestedFromRecord).toBe(true);
    expect(s.tools[`${PARENT}/3`]?.status).toBe('running');
    // The report comes off the persisted `details`, so it survives a reload.
    expect((s.tools[PARENT].details as { report?: string })?.report).toBe(
      'Two files.',
    );
  });
});
