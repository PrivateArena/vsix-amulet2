import type {
  SessionState,
  SessionStats,
} from '../../../../../shared/protocol';

/** One label/value line in the dialog. */
export interface InfoRow {
  label: string;
  value: string;
  /** Verbatim text offered for copying when the display value is elided (paths, ids). */
  copy?: string;
  /** Render the value in the code font (paths, ids). */
  mono?: boolean;
}

export interface InfoSection {
  title: string;
  rows: InfoRow[];
}

export interface SessionInfoView {
  /** Nothing to show — no runtime, so neither identity nor stats arrived. */
  waiting: boolean;
  sections: InfoSection[];
  /** Plain-text rendering, for the clipboard. */
  text: string;
}

const numbers = new Intl.NumberFormat('en-US');

/** `get_session_stats` is an unvalidated wire payload: a missing bucket must not print NaN. */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function count(value: number | undefined): string {
  return numbers.format(n(value));
}

function share(part: number | undefined, whole: number): string {
  if (!(whole > 0)) return '0.0%';
  return `${((n(part) / whole) * 100).toFixed(1)}%`;
}

/** `provider/id`, prefixed with the display name when pi gives it a distinct one. */
function modelLabel(session: SessionState | null): string | null {
  const model = session?.model;
  if (!model?.id) return model?.name ?? null;
  const qualified = `${model.provider}/${model.id}`;
  return model.name && model.name !== model.id
    ? `${model.name} (${qualified})`
    : qualified;
}

/**
 * Split the token buckets the way pi's own `/session` command splits them, so both
 * surfaces agree: `tokens.input` is the *uncached* prompt volume, while the "Input"
 * line is the whole prompt (uncached + cache reads + cache writes).
 */
function tokenRows(tokens: SessionStats['tokens'] | undefined): InfoRow[] {
  const input = n(tokens?.input);
  const cacheRead = n(tokens?.cacheRead);
  const cacheWrite = n(tokens?.cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const rows: InfoRow[] = [{ label: 'Input', value: count(prompt) }];
  if (prompt > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const written =
      cacheWrite > 0 ? ` (${count(cacheWrite)} written to cache)` : '';
    rows.push(
      {
        label: 'Cached',
        value: `${count(cacheRead)} (${share(cacheRead, prompt)})`,
      },
      {
        label: 'Uncached',
        value: `${count(input + cacheWrite)}${written}`,
      },
    );
  }
  rows.push(
    { label: 'Output', value: count(tokens?.output) },
    { label: 'Total', value: count(tokens?.total) },
  );
  return rows;
}

function buildSections(
  session: SessionState | null,
  stats: SessionStats | null,
): InfoSection[] {
  const sections: InfoSection[] = [];

  // `get_session_stats` echoes the identity too; `get_state` is the fallback while a
  // stats request is still in flight (e.g. right after a session switch).
  const file = stats?.sessionFile ?? session?.sessionFile;
  const id = stats?.sessionId ?? session?.sessionId;
  const identity: InfoRow[] = [];
  if (session?.sessionName)
    identity.push({ label: 'Name', value: session.sessionName });
  const model = modelLabel(session);
  if (model) identity.push({ label: 'Model', value: model });
  // Absent means "nothing applied", i.e. the model/provider default — not "off".
  if (session?.thinkingLevel)
    identity.push({ label: 'Thinking', value: session.thinkingLevel });
  if (file)
    identity.push({ label: 'File', value: file, copy: file, mono: true });
  if (id) identity.push({ label: 'ID', value: id, copy: id, mono: true });
  if (identity.length > 0) sections.push({ title: 'Session', rows: identity });

  if (stats) {
    sections.push({
      title: 'Messages',
      rows: [
        { label: 'Total', value: count(stats.totalMessages) },
        { label: 'User', value: count(stats.userMessages) },
        { label: 'Assistant', value: count(stats.assistantMessages) },
        {
          label: 'Tools',
          value: `${count(stats.toolCalls)} calls, ${count(stats.toolResults)} results`,
        },
      ],
    });

    sections.push({ title: 'Tokens', rows: tokenRows(stats.tokens) });

    const usage: InfoRow[] = [];
    const cost = n(stats.cost);
    if (cost > 0) usage.push({ label: 'Cost', value: `$${cost.toFixed(3)}` });
    const context = stats.contextUsage;
    if (context && n(context.contextWindow) > 0) {
      usage.push({
        label: 'Context',
        value: `${count(context.tokens)} / ${count(context.contextWindow)} (${share(context.tokens, context.contextWindow)})`,
      });
    }
    if (usage.length > 0) sections.push({ title: 'Usage', rows: usage });
  }

  return sections;
}

function toText(sections: InfoSection[]): string {
  return sections
    .map(
      (section) =>
        `${section.title}\n${section.rows.map((r) => `${r.label}: ${r.value}`).join('\n')}`,
    )
    .join('\n\n');
}

/**
 * Everything the session-info dialog shows, built from the two HostMessages the
 * webview already keeps. `get_session_stats` is the same call pi's own `/session`
 * command makes, so the counters and token split match the CLI figure for figure.
 */
export function buildSessionInfo(
  session: SessionState | null,
  stats: SessionStats | null,
): SessionInfoView {
  const sections = buildSections(session, stats);
  return {
    waiting: sections.length === 0,
    sections,
    text: toText(sections),
  };
}
