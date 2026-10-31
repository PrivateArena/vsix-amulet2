import { describe, expect, it } from 'vitest';
import type {
  SessionState,
  SessionStats,
} from '../../../../../shared/protocol';
import { buildSessionInfo } from './session-info';

const SESSION_ID = '01a19138-982e-724c-8b8d-675bbde77089';
const SESSION_FILE = `/home/user/.pi/agent/sessions/--repo-project--/2026-10-31T09-09-27-726Z_${SESSION_ID}.jsonl`;

/**
 * Figures captured from `pi`'s own `/session` output for the same session, so the
 * dialog is checked against the CLI rather than against our own arithmetic:
 * Total 210, User 3, Assistant 98, Tools 109 calls / 108 results,
 * Input 5,895,611, Cached 5,824,883 (98.8%), Uncached 70,728, Output 54,051,
 * Total 5,949,662.
 */
const stats: SessionStats = {
  sessionFile: SESSION_FILE,
  sessionId: SESSION_ID,
  userMessages: 3,
  assistantMessages: 98,
  toolCalls: 109,
  toolResults: 108,
  totalMessages: 210,
  // pi reports `input` without cache activity: 70,728 + 5,824,883 = 5,895,611.
  tokens: {
    input: 70_728,
    output: 54_051,
    cacheRead: 5_824_883,
    cacheWrite: 0,
    total: 5_949_662,
  },
  cost: 1.2345,
  contextUsage: { tokens: 120_000, contextWindow: 200_000, percent: 60 },
};

const session: SessionState = {
  model: {
    id: 'qwen3.8-flash-next',
    name: 'Qwen Flash',
    provider: 'openrouter',
  },
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionFile: SESSION_FILE,
  sessionId: SESSION_ID,
  autoCompactionEnabled: true,
  messageCount: 210,
  pendingMessageCount: 0,
};

const rows = (view: ReturnType<typeof buildSessionInfo>, title: string) =>
  Object.fromEntries(
    (view.sections.find((s) => s.title === title)?.rows ?? []).map((r) => [
      r.label,
      r.value,
    ]),
  );

describe('session info dialog', () => {
  it('splits tokens the way pi /session does', () => {
    const tokens = rows(buildSessionInfo(session, stats), 'Tokens');
    expect(tokens.Input).toBe('5,895,611');
    expect(tokens.Cached).toBe('5,824,883 (98.8%)');
    expect(tokens.Uncached).toBe('70,728');
    expect(tokens.Output).toBe('54,051');
    expect(tokens.Total).toBe('5,949,662');
  });

  it('reports cache writes inside the uncached portion', () => {
    const tokens = rows(
      buildSessionInfo(session, {
        ...stats,
        tokens: { ...stats.tokens, cacheWrite: 1_000 },
      }),
      'Tokens',
    );
    expect(tokens.Input).toBe('5,896,611');
    expect(tokens.Uncached).toBe('71,728 (1,000 written to cache)');
  });

  it('omits the cache split when the provider reports no cache activity', () => {
    const tokens = rows(
      buildSessionInfo(session, {
        ...stats,
        tokens: {
          input: 500,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          total: 520,
        },
      }),
      'Tokens',
    );
    expect(tokens).toEqual({ Input: '500', Output: '20', Total: '520' });
  });

  it('counts messages the way pi /session does', () => {
    const messages = rows(buildSessionInfo(session, stats), 'Messages');
    expect(messages).toEqual({
      Total: '210',
      User: '3',
      Assistant: '98',
      Tools: '109 calls, 108 results',
    });
  });

  it('reports cost and context window', () => {
    const usage = rows(buildSessionInfo(session, stats), 'Usage');
    expect(usage.Cost).toBe('$1.234');
    expect(usage.Context).toBe('120,000 / 200,000 (60.0%)');
  });

  it('omits usage lines the runtime cannot measure', () => {
    const view = buildSessionInfo(session, {
      ...stats,
      cost: 0,
      contextUsage: undefined,
    });
    expect(view.sections.map((s) => s.title)).not.toContain('Usage');
  });

  it('shows the session id and file so they can be checked against the CLI', () => {
    const view = buildSessionInfo(session, stats);
    const identity = rows(view, 'Session');
    expect(identity.ID).toBe(SESSION_ID);
    expect(identity.File).toBe(SESSION_FILE);
    const idRow = view.sections
      .find((s) => s.title === 'Session')!
      .rows.find((r) => r.label === 'ID')!;
    expect(idRow.copy).toBe(SESSION_ID);
    expect(view.text).toContain(`ID: ${SESSION_ID}`);
    expect(view.text).toContain(`File: ${SESSION_FILE}`);
  });

  it('names the model by provider/id and reports the applied thinking level', () => {
    const identity = rows(buildSessionInfo(session, stats), 'Session');
    expect(identity.Model).toBe('Qwen Flash (openrouter/qwen3.8-flash-next)');
    expect(identity.Thinking).toBeUndefined();
    const reasoning = rows(
      buildSessionInfo({ ...session, thinkingLevel: 'high' }, stats),
      'Session',
    );
    expect(reasoning.Thinking).toBe('high');
  });

  it('falls back to get_state for identity while stats are in flight', () => {
    const view = buildSessionInfo(session, null);
    expect(rows(view, 'Session').ID).toBe(SESSION_ID);
    expect(view.sections.map((s) => s.title)).toEqual(['Session']);
    expect(view.waiting).toBe(false);
  });

  it('renders from stats alone when get_state never arrived', () => {
    const view = buildSessionInfo(null, stats);
    expect(rows(view, 'Session').ID).toBe(SESSION_ID);
    expect(view.sections.map((s) => s.title)).toContain('Tokens');
  });

  it('never prints NaN for a payload with missing buckets', () => {
    const broken = {
      tokens: { input: 10, output: 2 },
      cost: 0,
    } as unknown as SessionStats;
    const tokens = rows(buildSessionInfo(null, broken), 'Tokens');
    expect(tokens).toEqual({ Input: '10', Output: '2', Total: '0' });
  });

  it('waits for the runtime instead of rendering an empty shell', () => {
    const view = buildSessionInfo(null, null);
    expect(view.waiting).toBe(true);
    expect(view.sections).toEqual([]);
    expect(view.text).toBe('');
  });
});
