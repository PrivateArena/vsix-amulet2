import { describe, expect, it } from 'vitest';
import {
  applyAssistantEvent,
  asText,
  asThinking,
  asToolCall,
  normalizeContent,
  stripEventImages,
  stripHistoryImagePayloads,
  stripImagePayloads,
  textOfContent,
  toolImagesOf,
} from './blocks';

describe('textOfContent', () => {
  it('concatenates text blocks with no separator by default', () => {
    expect(
      textOfContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('joins with the given separator', () => {
    expect(
      textOfContent(
        [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        ' ',
      ),
    ).toBe('a b');
  });

  it('ignores non-text blocks', () => {
    expect(
      textOfContent([
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'secret' },
        { type: 'toolCall', id: '1', name: 'bash' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('passes strings through unchanged', () => {
    expect(textOfContent('hello')).toBe('hello');
  });

  it('returns empty string for non-array, non-string input', () => {
    expect(textOfContent(undefined)).toBe('');
    expect(textOfContent(null)).toBe('');
    expect(textOfContent(42)).toBe('');
    expect(textOfContent({})).toBe('');
  });
});

describe('block guards', () => {
  it('asText narrows only well-formed text blocks', () => {
    expect(asText({ type: 'text', text: 'a' })?.text).toBe('a');
    expect(asText({ type: 'thinking', thinking: 'x' })).toBeNull();
    expect(asText({ type: 'text' })).toBeNull(); // missing text field
  });

  it('asThinking narrows only well-formed thinking blocks', () => {
    expect(asThinking({ type: 'thinking', thinking: 'x' })?.thinking).toBe('x');
    expect(asThinking({ type: 'text', text: 'a' })).toBeNull();
  });

  it('asToolCall narrows only well-formed tool-call blocks', () => {
    const call = asToolCall({ type: 'toolCall', id: 't1', name: 'bash' });
    expect(call?.id).toBe('t1');
    expect(call?.name).toBe('bash');
    expect(asToolCall({ type: 'toolCall' })).toBeNull(); // missing id
    expect(asToolCall({ type: 'text', text: 'a' })).toBeNull();
  });
});

describe('normalizeContent', () => {
  it('wraps the bare string bodies pi uses for user and system messages', () => {
    expect(normalizeContent('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
    // The leading system message: empty body, prompt text in `sections`.
    expect(normalizeContent('')).toEqual([]);
  });

  it('keeps a well-formed block array by reference', () => {
    const blocks = [{ type: 'text', text: 'a' }];
    expect(normalizeContent(blocks)).toBe(blocks);
  });

  it('drops malformed entries and non-array bodies', () => {
    const blocks = [{ type: 'text', text: 'a' }, null, 7, { text: 'no type' }];
    expect(normalizeContent(blocks)).toEqual([{ type: 'text', text: 'a' }]);
    expect(normalizeContent(undefined)).toEqual([]);
    expect(normalizeContent({})).toEqual([]);
  });
});

describe('applyAssistantEvent', () => {
  it('folds text deltas into one block and finalizes on text_end', () => {
    let blocks = normalizeContent([]);
    blocks = applyAssistantEvent(blocks, {
      type: 'text_start',
      contentIndex: 0,
    });
    blocks = applyAssistantEvent(blocks, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'He',
    });
    blocks = applyAssistantEvent(blocks, {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'llo',
    });
    expect(blocks).toEqual([{ type: 'text', text: 'Hello' }]);
    blocks = applyAssistantEvent(blocks, {
      type: 'text_end',
      contentIndex: 0,
      content: 'Hello there',
    });
    expect(blocks).toEqual([{ type: 'text', text: 'Hello there' }]);
  });

  it('replays a captured pi 1.4.0 thinking -> toolCall stream', () => {
    // Wire events recorded from `pi --mode rpc` (see tmp/rpc-probe.mjs).
    const wire = [
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: 'The user ' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'wants a command.' },
      {
        type: 'toolcall_start',
        contentIndex: 1,
        id: 'call_F9DfUR1RCP32NqW83R4UYego',
        toolName: 'bash',
      },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"command":' },
      { type: 'toolcall_delta', contentIndex: 1, delta: '"echo hi"}' },
      {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: {
          type: 'toolCall',
          id: 'call_F9DfUR1RCP32NqW83R4UYego',
          name: 'bash',
          arguments: { command: 'echo hi' },
        },
      },
      {
        type: 'thinking_end',
        contentIndex: 0,
        content: 'The user wants a command.',
      },
    ] as const;

    let blocks = normalizeContent([]);
    for (const ev of wire) blocks = applyAssistantEvent(blocks, ev);

    expect(blocks).toEqual([
      { type: 'thinking', thinking: 'The user wants a command.' },
      {
        type: 'toolCall',
        id: 'call_F9DfUR1RCP32NqW83R4UYego',
        name: 'bash',
        arguments: { command: 'echo hi' },
      },
    ]);
  });

  it('accumulates streamed tool args so a call is live before it ends', () => {
    let blocks = applyAssistantEvent(normalizeContent([]), {
      type: 'toolcall_start',
      contentIndex: 0,
      id: 't1',
      toolName: 'write',
    });
    blocks = applyAssistantEvent(blocks, {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"path":"a.ts"}',
    });
    expect(asToolCall(blocks[0])?.partialArgs).toBe('{"path":"a.ts"}');
  });

  it('pads a contentIndex gap and leaves the array alone for unknown events', () => {
    const padded = applyAssistantEvent([{ type: 'text', text: 'a' }], {
      type: 'text_delta',
      contentIndex: 2,
      delta: 'c',
    });
    expect(padded).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: '' },
      { type: 'text', text: 'c' },
    ]);

    const same = normalizeContent([{ type: 'text', text: 'a' }]);
    expect(applyAssistantEvent(same, { type: 'done', reason: 'stop' })).toBe(
      same,
    );
    expect(applyAssistantEvent(same, undefined)).toBe(same);
    expect(applyAssistantEvent(same, { contentIndex: 0 } as never)).toBe(same);
  });

  it('keeps provider signatures across the end events', () => {
    let blocks = applyAssistantEvent(normalizeContent([]), {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'x',
    });
    blocks = applyAssistantEvent(blocks, {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'y',
    });
    // Signature arrives on the authoritative block, not on the deltas.
    blocks = applyAssistantEvent(blocks, {
      type: 'thinking_end',
      contentIndex: 0,
      content: 'xy',
    });
    expect(asThinking(blocks[0])?.thinking).toBe('xy');
  });
});

describe('stripImagePayloads', () => {
  const image = { type: 'image', data: 'QUJD', mimeType: 'image/png' };

  it('drops the base64 payload and records the decoded size', () => {
    const text = { type: 'text', text: 'Read image file [image/png]' };
    const stripped = stripImagePayloads([text, image]) as Record<string, any>[];
    expect(stripped[0]).toBe(text);
    expect(stripped[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      bytes: 3,
    });
    // The wire object is shared with every other surface, so it is never mutated.
    expect(image.data).toBe('QUJD');
  });

  it('counts padding out of the payload', () => {
    const stripped = stripImagePayloads([
      { type: 'image', data: 'QQ==', mimeType: 'image/png' },
    ]) as Record<string, any>[];
    expect(stripped[0].bytes).toBe(1);
  });

  it('returns the array untouched when it holds no payload', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'image', mimeType: 'image/png', bytes: 12 },
    ];
    expect(stripImagePayloads(blocks)).toBe(blocks);
    expect(stripImagePayloads('plain string')).toBe('plain string');
  });
});

describe('toolImagesOf', () => {
  const content = [
    { type: 'text', text: 'Read image file [image/png]' },
    { type: 'image', mimeType: 'image/png', bytes: 4096 },
  ];

  it('turns image blocks into references carrying the call source', () => {
    expect(toolImagesOf(content, { path: 'tmp/shot.png' })).toEqual([
      { path: 'tmp/shot.png', mimeType: 'image/png', bytes: 4096 },
    ]);
  });

  it('measures a payload the host did not strip', () => {
    const refs = toolImagesOf(
      [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
      { file_path: '/tmp/a.png' },
    );
    expect(refs).toEqual([
      { path: '/tmp/a.png', mimeType: 'image/png', bytes: 3 },
    ]);
  });

  it('yields nothing for a text result, and no path for a call that has none', () => {
    expect(toolImagesOf([{ type: 'text', text: 'ok' }], { path: 'a.ts' })).toBe(
      undefined,
    );
    expect(toolImagesOf(undefined, undefined)).toBeUndefined();
    expect(toolImagesOf(content, { command: 'snap' })).toEqual([
      { path: undefined, mimeType: 'image/png', bytes: 4096 },
    ]);
  });
});

describe('stripEventImages', () => {
  const end = {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'read',
    result: {
      content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
      details: { ok: true },
    },
  };

  it('strips a tool result and leaves the event shape alone', () => {
    const forwarded = stripEventImages(end as never) as any;
    expect(forwarded.result.content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      bytes: 3,
    });
    expect(forwarded.result.details).toEqual({ ok: true });
    expect((end as any).result.content[0].data).toBe('QUJD');
  });

  it('strips the settled tool-result message of a message event', () => {
    const forwarded = stripEventImages({
      type: 'message_end',
      message: {
        role: 'toolResult',
        content: [{ type: 'image', data: 'QQ==' }],
      },
    } as never) as any;
    expect(forwarded.message.content).toEqual([{ type: 'image', bytes: 1 }]);
  });

  it('passes through events with nothing to strip, by identity', () => {
    const agentEnd = { type: 'agent_end' } as never;
    expect(stripEventImages(agentEnd)).toBe(agentEnd);
    const textEnd = {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }] },
    } as never;
    expect(stripEventImages(textEnd)).toBe(textEnd);
    // A user message's own attachment is input to the model, not a card's output.
    const user = {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'image', data: 'QQ==' }] },
    } as never;
    expect(stripEventImages(user)).toBe(user);
  });
});

describe('stripHistoryImagePayloads', () => {
  it('strips persisted tool results, not the message that follows them', () => {
    const assistant = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    };
    const result = {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
    };
    const out = stripHistoryImagePayloads([assistant, result] as never);
    expect(out[0]).toBe(assistant);
    expect(out[1]).not.toBe(result);
    expect((out[1] as any).content).toEqual([
      { type: 'image', mimeType: 'image/png', bytes: 3 },
    ]);
  });

  it('returns the same array when no message is a tool result', () => {
    const messages = [{ role: 'assistant', content: [] }] as never;
    expect(stripHistoryImagePayloads(messages)).toBe(messages);
  });
});

describe('stripEventImages — the run recap', () => {
  const image = () => ({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
  const result = () => ({
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'read',
    content: [image()],
  });

  it('strips the tool results a turn_end recaps', () => {
    const event = { type: 'turn_end', message: {}, toolResults: [result()] };
    const forwarded = stripEventImages(event as never) as any;
    expect(forwarded.toolResults[0].content).toEqual([
      { type: 'image', mimeType: 'image/png', bytes: 3 },
    ]);
    expect(event.toolResults[0].content[0].data).toBe('QUJD');
  });

  it('strips only the tool results among the messages an agent_end recaps', () => {
    const user = { role: 'user', content: [image()] };
    const event = {
      type: 'agent_end',
      messages: [user, result()],
      willRetry: false,
    };
    const forwarded = stripEventImages(event as never) as any;
    expect(forwarded.messages[0]).toBe(user);
    expect(forwarded.messages[1].content[0].bytes).toBe(3);
    expect(event.messages[1].content[0].data).toBe('QUJD');
  });

  it('leaves a recap with no tool results alone, by identity', () => {
    const event = {
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [] }],
    };
    expect(stripEventImages(event as never)).toBe(event);
  });
});
