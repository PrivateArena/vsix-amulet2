/**
 * Token-throughput maths for the live "Working" indicator.
 *
 * The pi wire carries no timing information at all: `message_update` deltas arrive
 * with a `usage` block that stays all-zero until the first `*_end` of the message,
 * and nothing else is stamped. So both rates are measured on our own clock:
 *
 * - **decode** — samples the streamed output token count and differentiates it over
 *   a trailing window. The reported `usage.output` is authoritative, so it becomes
 *   the base of the count and only the characters streamed *after* it are estimated.
 * - **prefill** — cannot be sampled live at all: the prompt is not counted until the
 *   runtime reports usage, which is after the first token by definition. It is
 *   derived retroactively as `prompt tokens / time-to-first-token`, so it appears a
 *   moment into each assistant message and covers the network round-trip too. Treat
 *   it as "how fast the prompt went in", not a hard prefill benchmark.
 */
import type { ContentBlock, Usage } from '../../../../shared/protocol';
import { asText, asThinking, asToolCall } from '../../../../shared/blocks';
import { formatTokens } from '../../utils/format';

/** Rough character cost of one token, for extrapolating between usage reports. */
export const CHARS_PER_TOKEN = 4;

/** Shortest window, and fewest tokens, a decode rate may be computed from. */
export const MIN_DECODE_WINDOW_MS = 500;
export const MIN_DECODE_TOKENS = 4;

/** Below these, the prefill figure is dominated by round-trip latency rather than prompt size. */
export const MIN_PREFILL_TTFT_MS = 50;
export const MIN_PREFILL_PROMPT_TOKENS = 32;

/** Characters of model output in a message so far (text, thinking and tool arguments). */
export function outputChars(blocks: ContentBlock[]): number {
  let chars = 0;
  for (const block of blocks) {
    const text = asText(block);
    if (text) {
      chars += text.text.length;
      continue;
    }
    const thinking = asThinking(block);
    if (thinking) {
      chars += thinking.thinking.length;
      continue;
    }
    const call = asToolCall(block);
    if (call) chars += call.partialArgs?.length ?? sizeOf(call.arguments);
  }
  return chars;
}

/** JSON length of parsed tool arguments — a stand-in for the streamed argument text. */
function sizeOf(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Estimated token cost of `chars` characters of output. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
}

/** Where a message's output count was last anchored to reported usage. */
export interface TokenBaseline {
  uid: string;
  /** `usage.output` at the anchor. */
  tokens: number;
  /** Output characters at the anchor. */
  chars: number;
}

export const NO_BASELINE: TokenBaseline = { uid: '', tokens: 0, chars: 0 };

/**
 * Output tokens produced by one assistant message so far, anchored on reported usage.
 *
 * `usage.output` only updates at block boundaries, so the characters streamed since
 * the anchor are added on top of it as an estimate. A new message — or a higher
 * report for the same one — moves the anchor, which is what keeps the estimate from
 * drifting across a long block.
 */
export function countOutputTokens(
  uid: string,
  blocks: ContentBlock[],
  usage: Usage | undefined,
  baseline: TokenBaseline,
): { baseline: TokenBaseline; tokens: number } {
  const chars = outputChars(blocks);
  const reported = usage?.output ?? 0;
  let anchored = baseline;
  if (baseline.uid !== uid) {
    // A new message: nothing is known about it until the runtime reports usage,
    // so its characters are pure estimate until that first report.
    anchored = { uid, tokens: reported, chars: reported > 0 ? chars : 0 };
  } else if (reported > baseline.tokens) {
    // A fresher report describes exactly what has streamed so far.
    anchored = { uid, tokens: reported, chars };
  }
  return {
    baseline: anchored,
    tokens: anchored.tokens + estimateTokens(chars - anchored.chars),
  };
}

/**
 * Time-to-first-token of one message, measured from arrival stamps, or null while
 * either half is still unknown.
 */
export function timeToFirstToken(
  startedAt: number | undefined,
  firstTokenAt: number | undefined,
): number | undefined {
  if (startedAt == null || firstTokenAt == null) return undefined;
  return Math.max(0, firstTokenAt - startedAt);
}

/** Prompt tokens the runtime had to process for one call, cached reads included. */
export function promptTokens(usage?: Usage): number {
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export interface RateSample {
  /** Epoch ms of the sample. */
  at: number;
  /** Cumulative output tokens at that instant. */
  tokens: number;
}

/**
 * Tokens/second across the newest span of `samples` that fits in `windowMs`.
 *
 * Returns null while the window is too thin to mean anything (no span, or fewer
 * than `minTokens` moved), which keeps the readout from flickering on a single delta.
 */
export function windowRate(
  samples: RateSample[],
  now: number,
  windowMs: number,
  minTokens = MIN_DECODE_TOKENS,
): number | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const cut = now - windowMs;
  let i = samples.length - 1;
  while (i > 0 && samples[i - 1].at >= cut) i--;
  const first = samples[i];
  const spanMs = last.at - first.at;
  if (spanMs < Math.min(MIN_DECODE_WINDOW_MS, windowMs)) return null;
  const tokens = last.tokens - first.tokens;
  if (tokens < minTokens) return null;
  return (tokens * 1000) / spanMs;
}

/**
 * Prefill (prompt processing) rate from the measured time-to-first-token, or null
 * while either half of the measurement is still unknown or too small to be meaningful.
 */
export function prefillTokensPerSecond(
  usage: Usage | undefined,
  ttftMs: number | undefined,
): number | null {
  if (ttftMs == null || ttftMs < MIN_PREFILL_TTFT_MS) return null;
  const tokens = promptTokens(usage);
  if (tokens < MIN_PREFILL_PROMPT_TOKENS) return null;
  return tokens / (ttftMs / 1000);
}

/** Rate for the readout: whole tokens per second, magnitude-suffixed like the context meter. */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  return formatTokens(Math.round(tokensPerSecond));
}
