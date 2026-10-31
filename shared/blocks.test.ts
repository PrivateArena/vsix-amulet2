import { describe, expect, it } from 'vitest';
import {
  applyAssistantEvent,
  asText,
  asThinking,
  asToolCall,
  normalizeContent,
  textOfContent,
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
