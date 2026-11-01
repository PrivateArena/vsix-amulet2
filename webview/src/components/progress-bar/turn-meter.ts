/**
 * The live throughput meter: accumulates samples across ticks and smooths them.
 *
 * Kept out of the hook so it can be tested by replaying a message stream with
 * synthetic clocks (see `turn-meter.test.ts`); the hook only supplies the clock,
 * the streaming message, and the re-render.
 */
import type { ContentBlock, Usage } from '../../../../shared/protocol';
import {
  countOutputTokens,
  NO_BASELINE,
  prefillTokensPerSecond,
  timeToFirstToken,
  windowRate,
  type RateSample,
  type TokenBaseline,
} from './token-rate';

/** Trailing span the decode rate is averaged over, so a burst is not mistaken for a rate. */
const DECODE_WINDOW_MS = 4000;
/** No new output for this long retires both rates: a tool is running, not the model. */
const DECODE_IDLE_MS = 2000;
/** Cap on kept samples — the window is a handful of ticks. */
const MAX_SAMPLES = 32;
/** Weight of a new reading in the smoothed rate. */
const DECODE_SMOOTHING = 0.35;

export interface TokenRates {
  /** Output (decode) tokens per second of the model right now. */
  decode: number | null;
  /** Prompt (prefill) tokens per second of the latest API call. */
  prefill: number | null;
}

export const NO_RATES: TokenRates = { decode: null, prefill: null };

/** The slice of a streaming assistant message the meter can measure. */
export interface MeteredMessage {
  uid: string;
  content: ContentBlock[];
  usage?: Usage;
  /** Arrival stamps, see `UiMessage`. */
  startedAt?: number;
  firstTokenAt?: number;
}

/** One decimal below 10, whole numbers above — enough resolution, no re-render churn. */
function roundRate(rate: number): number {
  return rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate);
}

export interface TurnMeter {
  /** Measure the turn at `now`; `message` is the streaming assistant message, or null. */
  measure(now: number, message: MeteredMessage | null): TokenRates;
}

export function createTurnMeter(): TurnMeter {
  const samples: RateSample[] = [];
  let baseline: TokenBaseline = NO_BASELINE;
  /** Message the samples are currently counting, and its booked output tokens. */
  let uid = '';
  let messageTokens = 0;
  /** Output tokens of the whole turn: what the samples accumulate. */
  let total = 0;
  let lastGrowth = 0;
  let decode: number | null = null;
  let prefill: number | null = null;
  /** Cached count of the last measurement, valid while the message content is untouched. */
  let counted: { baseline: TokenBaseline; tokens: number } = {
    baseline: NO_BASELINE,
    tokens: 0,
  };
  let lastContent: ContentBlock[] | null = null;
  let lastUsage: Usage | undefined;

  return {
    measure(now, message) {
      if (message) {
        if (message.uid !== uid) {
          // A new API call: restart the window here rather than let it span the gap
          // since the previous one — that gap is a tool call, not decode — and restart
          // the calibration, since `usage.output` is per message and not per turn.
          uid = message.uid;
          messageTokens = 0;
          baseline = NO_BASELINE;
          lastContent = null;
          lastUsage = undefined;
          samples.length = 0;
        }
        if (message.content !== lastContent || message.usage !== lastUsage) {
          counted = countOutputTokens(
            message.uid,
            message.content,
            message.usage,
            baseline,
          );
          baseline = counted.baseline;
          lastContent = message.content;
          lastUsage = message.usage;
        }
        if (counted.tokens > messageTokens) {
          // Sample the turn total, not the message count: the run's output is what
          // stays monotone across the several API calls one turn makes.
          total += counted.tokens - messageTokens;
          messageTokens = counted.tokens;
          lastGrowth = now;
          samples.push({ at: now, tokens: total });
          if (samples.length > MAX_SAMPLES) samples.shift();
        }
        const rate = windowRate(samples, now, DECODE_WINDOW_MS);
        if (rate != null) {
          decode =
            decode == null ? rate : decode + (rate - decode) * DECODE_SMOOTHING;
        }
        const measured = prefillTokensPerSecond(
          message.usage,
          timeToFirstToken(message.startedAt, message.firstTokenAt),
        );
        if (measured != null) prefill = measured;
      }
      if (now - lastGrowth > DECODE_IDLE_MS) {
        // Nothing is generating: an average over the gap describes a tool call, and a
        // prefill measured minutes ago is not the current speed. So the readout is just
        // the elapsed time until the model starts producing again.
        decode = null;
        prefill = null;
        samples.length = 0;
      }
      return {
        decode: decode == null ? null : roundRate(decode),
        prefill: prefill == null ? null : roundRate(prefill),
      };
    },
  };
}
