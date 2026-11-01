/**
 * Best-effort parse of a tool-call argument object that is still streaming.
 *
 * pi finalizes a call's `arguments` only at `toolcall_end`, and every
 * `tool_execution_*` event carries the finished object — so the one live source of
 * "what the model is typing right now" is the accumulated `toolcall_delta` text
 * (buffered on the block as `partialArgs` by `applyAssistantEvent`, see `blocks.ts`).
 * That text is incomplete JSON: a closed object, a string cut mid-value, or nothing yet.
 *
 * This scanner returns whatever is recoverable and never throws, so a card can show a
 * file path or a half-written body before the call is valid. The rules are what a reader
 * expects from the visible text: a value appears as soon as it has started, an
 * unterminated string is its prefix, and a truncated container keeps its finished keys.
 *
 * Lives in `shared/` next to `blocks.ts` because it reads wire data — for now only the
 * webview imports it, and the host forwards the deltas untouched.
 */

/** Parse result: the recovered value and the offset to continue reading from. */
interface Parsed {
  value: unknown;
  next: number;
}

/** Depth guard: past this the buffer is malformed input, not a streaming call. */
const MAX_DEPTH = 32;

/**
 * Parse an in-flight (possibly incomplete) JSON argument object.
 *
 * Returns `undefined` when nothing is known yet — no object opened, or no key has
 * reached a value — so a caller can tell "no arguments" from "arguments, all empty".
 */
export function parseStreamingToolArgs(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  // The buffer re-scans on every rendered frame, so avoid a copy of it when there is
  // nothing in front of the object to skip — which is the normal case.
  const body = start > 0 ? raw.slice(start) : raw;
  // As soon as the buffer parses, trust JSON over the tolerant scan.
  try {
    const done = JSON.parse(body);
    if (isRecord(done)) return withKeys(done);
  } catch {
    // Expected while the call is still streaming — fall through to the scan.
  }
  const parsed = scanValue(raw, start, 0);
  return parsed && isRecord(parsed.value) ? withKeys(parsed.value) : undefined;
}

/** `undefined` for an argument object no key has reached a value in yet. */
function withKeys(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return Object.keys(record).length ? record : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function scanValue(
  text: string,
  from: number,
  depth: number,
): Parsed | undefined {
  const i = skipSpace(text, from);
  if (i >= text.length) return undefined;
  switch (text[i]) {
    case '{':
      return depth >= MAX_DEPTH ? undefined : scanObject(text, i, depth);
    case '[':
      return depth >= MAX_DEPTH ? undefined : scanArray(text, i, depth);
    case '"':
      return scanString(text, i);
    default:
      return scanAtom(text, i);
  }
}

function scanObject(
  text: string,
  from: number,
  depth: number,
): Parsed | undefined {
  const out: Record<string, unknown> = {};
  let i = from + 1;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) return { value: out, next: i };
    const char = text[i];
    if (char === '}') return { value: out, next: i + 1 };
    // A separator we already consumed alongside the value it followed.
    if (char === ',') {
      i++;
      continue;
    }
    if (char !== '"') return { value: out, next: i };
    const key = scanString(text, i);
    if (!key || typeof key.value !== 'string') return { value: out, next: i };
    const colon = skipSpace(text, key.next);
    if (text[colon] !== ':') return { value: out, next: colon };
    const value = scanValue(text, colon + 1, depth + 1);
    // The value has not started: this key is still only a name.
    if (!value) return { value: out, next: colon + 1 };
    out[key.value] = value.value;
    i = value.next;
  }
}

function scanArray(text: string, from: number, depth: number): Parsed {
  const out: unknown[] = [];
  let i = from + 1;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) return { value: out, next: i };
    if (text[i] === ']') return { value: out, next: i + 1 };
    if (text[i] === ',') {
      i++;
      continue;
    }
    const value = scanValue(text, i, depth + 1);
    if (!value || value.next <= i) return { value: out, next: i };
    // An object element that has opened but produced nothing yet is the array having
    // started its next entry, not an entry to render (a `write` has one body, an `edit`
    // gets one object per replacement).
    if (!isEmptyRecord(value.value)) out.push(value.value);
    i = value.next;
  }
}

/** Read a JSON string from its opening quote, tolerating a missing closing one. */
function scanString(text: string, from: number): Parsed | undefined {
  if (text[from] !== '"') return undefined;
  // Runs are sliced rather than built one character at a time: the buffer is re-scanned on
  // every rendered frame, and a file body is hundreds of kilobytes of plain text.
  const parts: string[] = [];
  let i = from + 1;
  for (;;) {
    const quote = text.indexOf('"', i);
    const escape = text.indexOf('\\', i);
    if (quote < 0 && escape < 0) {
      // Unterminated: the prefix is what the model has produced so far.
      parts.push(text.slice(i));
      return { value: parts.join(''), next: text.length };
    }
    if (quote >= 0 && (escape < 0 || quote < escape)) {
      parts.push(text.slice(i, quote));
      return { value: parts.join(''), next: quote + 1 };
    }
    parts.push(text.slice(i, escape));
    const esc = text[escape + 1];
    // An escape whose tail has not streamed yet — what came before it is still known.
    if (esc === undefined) return { value: parts.join(''), next: escape };
    if (esc === 'u') {
      const hex = text.slice(escape + 2, escape + 6);
      if (!HEX4.test(hex)) {
        if (hex.length < 4) return { value: parts.join(''), next: escape };
        // Not a `\u` sequence after all: keep the backslash the model wrote and move on.
        parts.push('\\u');
        i = escape + 2;
        continue;
      }
      // Astral characters arrive as two surrogate units, which concatenate back correctly.
      parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
      i = escape + 6;
      continue;
    }
    // An escape JSON does not define (`\x` in a source file whose author forgot to double
    // the backslash) is shown as written rather than ending the body there, which a reader
    // would read as a stalled stream.
    parts.push(ESCAPES[esc] ?? `\\${esc}`);
    i = escape + 2;
  }
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** number / true / false / null, as far as they have arrived. */
function scanAtom(text: string, from: number): Parsed | undefined {
  let i = from;
  while (i < text.length && !ATOM_END.test(text[i])) i++;
  const token = text.slice(from, i);
  if (!token) return undefined;
  // A token that runs to the end of the buffer has not finished arriving: half a keyword
  // is no value, and half a number is not the number the model means (`1` for `120`).
  if (i >= text.length) return undefined;
  if (token === 'true') return { value: true, next: i };
  if (token === 'false') return { value: false, next: i };
  if (token === 'null') return { value: null, next: i };
  const num = Number(token);
  return Number.isFinite(num) ? { value: num, next: i } : undefined;
}

const ATOM_END = /[\s,}\]"]/;

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && WHITESPACE.test(text[i])) i++;
  return i;
}

const WHITESPACE = /[ \t\n\r]/;
