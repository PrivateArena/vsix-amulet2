/**
 * Reading of the subagent tool's `details` payload.
 *
 * pi's subagent tool (`ctx.executeTool()` runner) reports its progress as
 * `tool_execution_update.partialResult.details` while it runs and again on
 * `tool_execution_end.result.details`. The shape is the runtime extension's own —
 * typed as `unknown` in the protocol — so it is narrowed here and nowhere else.
 */
import { asRecord, formatDuration, oneLine } from '../tool-display';
import { redactText } from '../../../stores/privacy-store';

/** Card header text while the child runs; the role name goes in the meta line. */
export const SUBAGENT_TITLE = 'Launch Subagent';

/**
 * What the child is doing right now, as pi-subagent itself reports it.
 *
 * `finalReport` is the one the card is asked about: the run's guaranteed-report turn, where the child is
 * writing the answer rather than working. `writing` is the weaker statement that a message is arriving with
 * no tool call in it yet, which is what a running child looks like from the inside and is honest either way.
 * Absent on a runtime that predates the field.
 */
export type SubagentPhase = 'thinking' | 'writing' | 'calling' | 'finalReport';

/** One turn of the child's reasoning. The turn number is what places it against the call list. */
export interface SubagentReasoningTurn {
  turn: number;
  text: string;
}

/** How the footer states the run's state, and what colour it states it in. */
export interface SubagentStatus {
  text: string;
  tone: 'working' | 'report' | 'done' | 'stopped' | 'failed';
}

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
  /** Live phase, while the run is going. Absent on an older pi-subagent. */
  phase?: SubagentPhase;
  /**
   * What the child was thinking, turn by turn — a **bounded** view (pi-subagent keeps the newest turns and
   * says so in {@link reasoningTruncated}). The transcript behind {@link childSessionFile} is the complete
   * record, and thinking costs no budget, which is why it is worth showing and not worth shipping whole.
   */
  reasoning?: SubagentReasoningTurn[];
  reasoningTruncated?: boolean;
  /** The child's own transcript: whole conversation, whole thinking. Reported as soon as it exists. */
  childSessionFile?: string;
  /** pi-subagent's harness log of this run (`subagent.debugLog`). */
  turnLogFile?: string;
  /**
   * The human's own sentence, set when a client stopped this run through the subagent stop API rather than
   * letting it report. Its presence is the fact the card needs — that *they* ended it, not that it failed.
   */
  stoppedBy?: string;
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

/** A one-line string field: the header shows `subtitle` in a single ellipsized row. */
function line(value: unknown): string | undefined {
  const text = str(value);
  return text ? oneLine(text) : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** An unknown string is not a phase: a card must not invent a state the runtime never reported. */
function phaseOf(value: unknown): SubagentPhase | undefined {
  return value === 'thinking' ||
    value === 'writing' ||
    value === 'calling' ||
    value === 'finalReport'
    ? value
    : undefined;
}

/**
 * The reasoning trail, narrowed. Each entry needs a thought and a turn to belong to; anything else is
 * dropped rather than rendered, because a row that opens onto nothing is a control that reads as broken.
 */
function reasoningOf(
  value: unknown,
): { turns: SubagentReasoningTurn[]; truncated: boolean } | undefined {
  const trail = asRecord(value);
  const entries = trail.turns;
  if (!Array.isArray(entries)) return undefined;
  const turns = entries.flatMap((entry) => {
    const raw = asRecord(entry);
    const text = str(raw.text);
    const turn = num(raw.turn);
    return text ? [{ turn: turn ?? 0, text }] : [];
  });
  return turns.length
    ? { turns, truncated: bool(trail.truncated) === true }
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
  const reasoning = reasoningOf(raw.reasoning);

  return {
    title: str(pendant.title) ?? str(raw.displayName),
    subtitle: line(pendant.subtitle) ?? line(raw.task) ?? line(raw.description),
    status: str(raw.status),
    exit: str(raw.exit),
    report: str(raw.report),
    model: str(raw.model) ?? str(raw.modelName),
    tokens: str(raw.tokens),
    turns: num(raw.turns),
    toolCalls: num(raw.toolCalls),
    activity: str(raw.activity),
    phase: phaseOf(raw.phase),
    elapsedMs: num(raw.elapsedMs),
    reasoning: reasoning?.turns,
    reasoningTruncated: reasoning?.truncated,
    childSessionFile: str(raw.childSessionFile),
    turnLogFile: str(raw.turnLogFile),
    stoppedBy: str(raw.stoppedBy),
  };
}

/** Whether a tool name belongs to the subagent family (built-in and extension tools). */
export function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name === 'task' || name === 'launch_subagent';
}

/**
 * The task the main agent handed the child, untruncated.
 *
 * The card header only has room for one line of it, so this is what the hover
 * tooltip and the copy button carry. `args.task` is the built-in subagent tool's
 * own field (and the only place the full multi-line text ever appears); a fork may
 * name it `prompt` or `message`, and `details.subtitle` is the runtime's one-line
 * rendering of it, used when the arguments are not available.
 */
export function subagentPrompt(
  args: unknown,
  details?: SubagentDetailsView,
): string {
  const record = asRecord(args);
  for (const key of ['task', 'prompt', 'message', 'instruction']) {
    const text = str(record[key]);
    if (text) return redactText(text);
  }
  return redactText(details?.subtitle ?? '');
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
  const prompt = subagentPrompt(args);
  return {
    subtitle: prompt ? oneLine(prompt) : undefined,
  };
}

/**
 * The quiet half of the card footer: role, counters, cost, model. The loud half — what the run is doing or
 * how it ended — is {@link subagentStatusOf}, which is why the exit and the current tool are not repeated here.
 */
export function subagentMetaLine(
  details: SubagentDetailsView,
  running: boolean,
): string {
  const parts: string[] = [];
  const role = details.title ?? details.status;
  if (role) parts.push(role);
  if (running) {
    if (details.turns != null) parts.push(`${details.turns} turns`);
    const elapsed = formatDuration(details.elapsedMs);
    if (elapsed) parts.push(elapsed);
  } else {
    // The one difference between a child that was stopped and a child that failed that the human can act on,
    // and it is otherwise invisible here: the note itself sits in the model-facing header, which `cleanReport`
    // strips out of the report the card shows. The sentence is not repeated back — they wrote it.
    if (details.stoppedBy) parts.push('stopped by you');
    if (details.turns != null) parts.push(`${details.turns} turns`);
    if (details.toolCalls != null) parts.push(`${details.toolCalls} tool uses`);
  }
  if (details.tokens) parts.push(details.tokens);
  if (details.model) parts.push(details.model);
  return redactText(parts.join(' · '));
}

/** The words the footer ends with, per terminal exit. An unknown exit says nothing rather than "failed". */
const EXIT_WORDS: Record<
  string,
  { text: string; tone: SubagentStatus['tone'] }
> = {
  done: { text: 'Done', tone: 'done' },
  aborted: { text: 'Stopped', tone: 'stopped' },
  timeout: { text: 'Timed out', tone: 'stopped' },
  maxTurns: { text: 'Out of turns', tone: 'stopped' },
  callLimit: { text: 'Out of tool calls', tone: 'stopped' },
  overflow: { text: 'Context full', tone: 'stopped' },
  error: { text: 'Failed', tone: 'failed' },
};

/** Same rule for a payload that reports a `status` but no `exit` (a stopped or completed older runtime). */
const STATUS_WORDS: Record<
  string,
  { text: string; tone: SubagentStatus['tone'] }
> = {
  completed: { text: 'Done', tone: 'done' },
  stopped: { text: 'Stopped', tone: 'stopped' },
  aborted: { text: 'Stopped', tone: 'stopped' },
  error: { text: 'Failed', tone: 'failed' },
  queued: { text: 'Queued', tone: 'working' },
};

/**
 * The state the footer leads with, in its own colour: which half of the run the human is looking at while
 * it goes on, and how it ended once it does not.
 *
 * While the run is live this answers the two questions the card used to leave open — is the child still
 * working, or is it already writing what it found? — and the report is the interesting half, so the phase
 * that means "answer arriving" gets its own tone. On a settled run the exit is restated in words a human
 * reads, because `timeout` and `maxTurns` are otherwise two tokens nobody recognises at a glance.
 *
 * Returns null when the payload names neither: a card with no state to report shows the stats alone rather
 * than a guess.
 */
export function subagentStatusOf(
  details: SubagentDetailsView,
  running: boolean,
): SubagentStatus | null {
  if (running) {
    switch (details.phase) {
      case 'finalReport':
        return { text: 'Writing the final report…', tone: 'report' };
      case 'writing':
        return { text: 'Writing…', tone: 'report' };
      case 'calling':
        return { text: callingText(details.activity), tone: 'working' };
      case 'thinking':
        return { text: 'Thinking…', tone: 'working' };
      default:
        // No phase reported: the tool the child was last seen calling is all the runtime will say.
        return { text: callingText(details.activity), tone: 'working' };
    }
  }
  const word =
    (details.exit && EXIT_WORDS[details.exit]) ||
    (details.status && STATUS_WORDS[details.status]);
  return word ? { ...word, text: redactText(word.text) } : null;
}

function callingText(activity: string | undefined): string {
  return activity && activity !== 'thinking'
    ? `Calling ${activity}…`
    : 'Working…';
}

/**
 * Whether this run left a file the card can offer to open. The path itself never travels to the webview's
 * click — the host keeps its own record and resolves the call id against it — so all the card can know is
 * that the runtime named one.
 */
export function subagentHasLog(details: SubagentDetailsView): boolean {
  return !!(details.childSessionFile || details.turnLogFile);
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
