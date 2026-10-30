/**
 * Reading of the subagent tool's `details` payload.
 *
 * pi's subagent tool (`ctx.executeTool()` runner) reports its progress as
 * `tool_execution_update.partialResult.details` while it runs and again on
 * `tool_execution_end.result.details`. The shape is the runtime extension's own —
 * typed as `unknown` in the protocol — so it is narrowed here and nowhere else.
 */
import { asRecord } from '../tool-display';

/** Card header text while the child runs; the role name goes in the meta line. */
export const SUBAGENT_TITLE = 'Launch Subagent';

export interface SubagentDetailsView {
  /** Role display name, e.g. `Explore` or `General Purpose`. */
  title?: string;
  /** The task, one line. */
  subtitle?: string;
  /** `running` | `queued` | `completed` | `stopped` | `aborted` | `error`. */
  status?: string;
  /** Terminal outcome: `done` | `timeout` | `maxTurns` | `aborted` | `error` … */
  exit?: string;
  /** The child's final report. Only present once it settles. */
  report?: string;
  model?: string;
  /** Pre-formatted token total, e.g. `4.2k token` (empty string when unknown). */
  tokens?: string;
  turns?: number;
  toolCalls?: number;
  /** Name of the tool the child is calling right now, for the live line. */
  activity?: string;
  elapsedMs?: number;
  childSessionFile?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Narrow an arbitrary `details` payload to a subagent card, or null when the
 * payload is not one. Markers: the `pendant` display block, a `report`, a child
 * session id, or the `{displayName, role}` pair the extension always sends.
 */
export function readSubagentDetails(
  details: unknown,
): SubagentDetailsView | null {
  const raw = asRecord(details);
  const pendant = asRecord(raw.pendant);
  const looksLikeSubagent =
    Object.keys(pendant).length > 0 ||
    str(raw.report) !== undefined ||
    str(raw.childSessionId) !== undefined ||
    (str(raw.displayName) !== undefined && str(raw.role) !== undefined);
  if (!looksLikeSubagent) return null;

  return {
    title: str(pendant.title) ?? str(raw.displayName),
    subtitle: str(pendant.subtitle) ?? str(raw.task) ?? str(raw.description),
    status: str(raw.status),
    exit: str(raw.exit),
    report: str(raw.report),
    model: str(raw.model) ?? str(raw.modelName),
    tokens: str(raw.tokens),
    turns: num(raw.turns),
    toolCalls: num(raw.toolCalls),
    activity: str(raw.activity),
    elapsedMs: num(raw.elapsedMs),
    childSessionFile: str(raw.childSessionFile),
  };
}

/** Whether a tool name belongs to the subagent family (built-in and extension tools). */
export function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name === 'task' || name === 'launch_subagent';
}

/**
 * Card view for any tool: the parsed `details` when this is a subagent result, a
 * name-based fallback while the arguments are still streaming (no `details` yet),
 * or null for every other tool.
 */
export function resolveSubagentCard(
  name: string,
  details: unknown,
  args: unknown,
): SubagentDetailsView | null {
  const parsed = readSubagentDetails(details);
  if (parsed) return parsed;
  if (!isSubagentTool(name)) return null;
  const task = asRecord(args).task;
  return {
    subtitle:
      typeof task === 'string'
        ? task.replace(/\s*\n\s*/g, ' ').trim()
        : undefined,
  };
}

/** `explore · 5 turns · 6 tool uses · 4.2k token · timeout`, skipping what is unknown. */
export function subagentMetaLine(
  details: SubagentDetailsView,
  running: boolean,
): string {
  const parts: string[] = [];
  const role = details.title ?? details.status;
  if (role) parts.push(role);
  if (running) {
    if (details.turns != null) parts.push(`${details.turns} turns`);
    if (details.activity) parts.push(`calling ${details.activity}`);
  } else {
    if (details.exit && details.exit !== 'done') parts.push(details.exit);
    if (details.turns != null) parts.push(`${details.turns} turns`);
    if (details.toolCalls != null) parts.push(`${details.toolCalls} tool uses`);
  }
  if (details.tokens) parts.push(details.tokens);
  if (details.model) parts.push(details.model);
  return parts.join(' · ');
}

/**
 * Strip the model-facing wrapper the subagent tool puts around its result text —
 * a leading `[subagent … · 55 turns · …]` block plus `model:`/`transcript:` lines —
 * leaving the report itself.
 */
export function cleanReport(text: string): string {
  const trimmed = text.trim();
  if (!/^\[\s*subagent/i.test(trimmed)) return trimmed;
  const end = trimmed.indexOf('\n\n');
  return end > 0 ? trimmed.slice(end + 2).trim() : trimmed;
}
