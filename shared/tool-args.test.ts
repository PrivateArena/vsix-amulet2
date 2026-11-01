import { describe, expect, it } from 'vitest';
import { parseStreamingToolArgs } from './tool-args';

describe('parseStreamingToolArgs — completed buffers', () => {
  it('parses a finished argument object', () => {
    expect(
      parseStreamingToolArgs(
        '{"path":"src/a.ts","content":"export const a = 1;\\n"}',
      ),
    ).toEqual({ path: 'src/a.ts', content: 'export const a = 1;\n' });
  });

  it('ignores anything the model streamed before the opening brace', () => {
    expect(parseStreamingToolArgs('  sure! {"command":"ls"}')).toEqual({
      command: 'ls',
    });
  });

  it('decodes the escape sequences a file body carries', () => {
    expect(
      parseStreamingToolArgs('{"content":"a\\tb\\nc \\"q\\" \\\\ \\u00e9"}'),
    ).toEqual({ content: 'a\tb\nc "q" \\ é' });
  });

  it('keeps nested arrays of objects (edit) and scalars', () => {
    expect(
      parseStreamingToolArgs(
        '{"path":"p","edits":[{"oldText":"a","newText":"b"}],"timeout":30,"x":true,"y":null}',
      ),
    ).toEqual({
      path: 'p',
      edits: [{ oldText: 'a', newText: 'b' }],
      timeout: 30,
      x: true,
      y: null,
    });
  });
});

describe('parseStreamingToolArgs — truncated buffers', () => {
  it('returns undefined until a key has reached a value', () => {
    expect(parseStreamingToolArgs('')).toBeUndefined();
    expect(parseStreamingToolArgs('{')).toBeUndefined();
    expect(parseStreamingToolArgs('{"pat')).toBeUndefined();
    expect(parseStreamingToolArgs('{"path"')).toBeUndefined();
    expect(parseStreamingToolArgs('{"path":')).toBeUndefined();
  });

  it('reports a string that is still streaming, empty prefix included', () => {
    expect(parseStreamingToolArgs('{"path":"')).toEqual({ path: '' });
    expect(parseStreamingToolArgs('{"path":"src/se')).toEqual({
      path: 'src/se',
    });
    expect(parseStreamingToolArgs('{"content":"line one\\nline t')).toEqual({
      content: 'line one\nline t',
    });
  });

  it('keeps the finished keys while a later one streams', () => {
    expect(
      parseStreamingToolArgs('{"path":"a.md","content":"# Title\\n\\nBody he'),
    ).toEqual({ path: 'a.md', content: '# Title\n\nBody he' });
  });

  it('drops an escape sequence whose tail has not arrived', () => {
    expect(parseStreamingToolArgs('{"content":"a\\')).toEqual({ content: 'a' });
    expect(parseStreamingToolArgs('{"content":"a\\n b\\u00')).toEqual({
      content: 'a\n b',
    });
  });

  it('grows the edit preview as its array fills in', () => {
    expect(parseStreamingToolArgs('{"path":"p","edits":[')).toEqual({
      path: 'p',
      edits: [],
    });
    expect(
      parseStreamingToolArgs('{"path":"p","edits":[{"oldText":"x"'),
    ).toEqual({ path: 'p', edits: [{ oldText: 'x' }] });
    expect(
      parseStreamingToolArgs(
        '{"path":"p","edits":[{"oldText":"x","newText":"y"},{"old',
      ),
    ).toEqual({ path: 'p', edits: [{ oldText: 'x', newText: 'y' }] });
  });

  it('treats a value that has not finished arriving as no value', () => {
    expect(parseStreamingToolArgs('{"a":tru')).toBeUndefined();
    expect(parseStreamingToolArgs('{"a":1')).toBeUndefined();
    expect(parseStreamingToolArgs('{"a":1,')).toEqual({ a: 1 });
    expect(parseStreamingToolArgs('{"a":true,"b":fals')).toEqual({ a: true });
  });

  it('keeps a body whose escapes are not valid JSON, and the keys after it', () => {
    // A model writing source code can emit `\x1b` where JSON needs `\\x1b`; the preview has
    // to keep growing, not look stalled at the first bad escape.
    expect(
      parseStreamingToolArgs('{"content":"a\\x1b[0m","path":"p"}'),
    ).toEqual({
      content: 'a\\x1b[0m',
      path: 'p',
    });
    expect(
      parseStreamingToolArgs('{"content":"a\\u00zz b","path":"p"}'),
    ).toEqual({ content: 'a\\u00zz b', path: 'p' });
  });

  it('decodes surrogate pairs and carriage returns', () => {
    expect(
      parseStreamingToolArgs('{"content":"ok \\ud83d\\ude00\\r\\nnext"}'),
    ).toEqual({ content: 'ok 😀\r\nnext' });
  });

  it('survives malformed input without throwing', () => {
    expect(parseStreamingToolArgs('{"a":}')).toBeUndefined();
    expect(parseStreamingToolArgs('{"a":1,,"b":2}')).toEqual({
      a: 1,
      b: 2,
    });
    expect(parseStreamingToolArgs('not json at all')).toBeUndefined();
  });

  it('bounds its recursion instead of following a pathological depth', () => {
    const deep = `{"a":${'['.repeat(400)}`;
    expect(parseStreamingToolArgs(deep)?.a).toBeInstanceOf(Array);
  });
});
