import type { SessionStats, Usage } from '../../../../../shared/protocol';
import type { UiMessage } from '../../../store';

/**
 * What the meter shows: how much of the window the next request will need.
 * `live` marks a figure read off the in-flight assistant message rather than from
 * the runtime's own `get_session_stats` answer.
 */
export interface ContextUsageView {
  tokens: number;
  contextWindow: number;
  percent: number;
  live: boolean;
}

/**
 * Context tokens for one assistant message, computed exactly the way pi computes
 * `contextUsage.tokens` for `get_session_stats`: `totalTokens` when the provider
 * reports it, otherwise the sum of the four buckets. Null for a message that has
 * no usage yet — the first deltas carry an all-zero `usage`, and showing that
 * would drop the ring to empty on every run.
 */
export function contextTokensOf(usage?: Usage): number | null {
  if (!usage) return null;
  const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const tokens = usage.totalTokens || sum;
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

/** Tokens used by the message the runtime is still writing, newest first. */
function liveContextTokens(messages: UiMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.streaming) continue;
    return contextTokensOf(message.usage);
  }
  return null;
}

function clampPercent(ratio: number): number {
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/**
 * Resolve the context usage to render.
 *
 * `get_session_stats` only knows about *persisted* messages, so between two LLM
 * calls the runtime's own number is already stale — a long answer or a big tool
 * result changes the window mid-turn. The streaming message's `usage` rides on
 * every `message_update` delta, though, and pi's formula gives the same result
 * once it persists the message, so the meter can follow the turn live without
 * inventing its own arithmetic.
 */
export function contextUsageOf(
  stats: SessionStats | null,
  messages: UiMessage[],
): ContextUsageView | null {
  const contextWindow = stats?.contextUsage?.contextWindow ?? 0;
  if (!(contextWindow > 0)) return null;

  const live = liveContextTokens(messages);
  const reported = stats?.contextUsage?.tokens;
  const tokens = live ?? (typeof reported === 'number' ? reported : null);
  if (tokens == null || !Number.isFinite(tokens)) return null;

  return {
    tokens,
    contextWindow,
    percent: clampPercent(tokens / contextWindow),
    live: live != null,
  };
}
