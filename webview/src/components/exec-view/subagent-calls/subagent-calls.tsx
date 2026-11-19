import { useState } from 'react';
import { LuBrain, LuCheck, LuCopy, LuFileText, LuX } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import type { ToolExec } from '../../../store';
import { useRedact } from '../../../stores/privacy-store';
import { useStickToBottom } from '../../../hooks/use-stick-to-bottom';
import { useTickingClock } from '../../../hooks/use-ticking-clock';
import { useCopyFeedback } from '../../../hooks/use-copy-feedback';
import { MdRender } from '../../md-render';
import { LoadingPulse } from '../../ui/ld';
import { Tooltip } from '../../ui/tooltip';
import {
  FILE_TOOLS,
  TOOL_LABELS,
  childCalls,
  countCallRows,
  oneLine,
  tipHead,
  tipTail,
  toolDuration,
  toolFullText,
  toolRowPreview,
} from '../tool-display';
import {
  subagentHasLog,
  subagentMetaLine,
  subagentStatusOf,
  type SubagentDetailsView,
  type SubagentReasoningTurn,
} from './subagent-details';
import { StopActions } from '../stop-actions';
import { ToolImages } from '../tool-images';
import './subagent-calls.scss';

export interface SubagentCallsProps {
  /** Id of the subagent call this card shows, for the controls that address the host. */
  toolCallId: string;
  /** Direct calls this tool made, in the order it made them. */
  calls: ToolExec[];
  /** Whole tool map, so a row can resolve its own children and its output. */
  tools?: Record<string, ToolExec>;
  /** Parsed `details` of the parent tool, never null. */
  details: SubagentDetailsView;
  /** Report body to show under the call list; resolved by the card owner. */
  report?: string;
  status: ToolExec['status'];
  /** False when pi truncated the nested-call record (count/argument budgets). */
  complete?: boolean;
  /**
   * False when this list came back from the runtime's persisted record rather than from
   * live events: it carries no outputs, so most rows there have nothing to show.
   */
  outputsStored?: boolean;
}

/**
 * Body of a subagent card: the calls the child made (live, streamed), what it thought
 * between them, then its report.
 *
 * Every nested call arrives as its own `tool_execution_*` event carrying
 * `parentToolCallId`, so rows get real arguments, per-call duration and — while the
 * run is live — the call's output for expansion. Thinking has no such event: a child is
 * an in-process session whose deltas never reach the wire, so its reasoning arrives inside
 * the parent's `details` as a bounded trail (`subagent.reasoning`), keyed by the child's own
 * turn number — which is why it is its own section rather than a row among the calls,
 * whose order Amulet cannot anchor a thinking block to.
 */
export function SubagentCalls({
  toolCallId,
  calls,
  tools,
  details,
  report,
  status,
  complete,
  outputsStored,
}: SubagentCallsProps) {
  const running = status === 'running';
  const meta = subagentMetaLine(details, running);
  const state = subagentStatusOf(details, running);
  // The list grows while the child works, and the interesting row is always the last
  // one — so it follows the calls, until the reader scrolls up to look at something.
  // A finished card keeps no such grip: opened later, it reads from the top.
  const follow = useStickToBottom<HTMLUListElement>(
    countCallRows(calls, tools ?? {}),
    running,
  );
  const reasoning = details.reasoning;

  return (
    <div className="subagent-calls">
      {calls.length > 0 ? (
        <ul
          className="sub-call-list"
          ref={follow.ref}
          onScroll={follow.onScroll}>
          {calls.map((call) => (
            <NestedCallRow
              key={call.toolCallId}
              tool={call}
              tools={tools ?? {}}
            />
          ))}
        </ul>
      ) : reasoning?.length ? null : (
        <div className="sub-call-waiting">
          {running ? 'Waiting for the first call…' : 'No tool calls'}
        </div>
      )}
      {complete === false && (
        <div className="sub-call-note">
          Some calls were omitted from the runtime's nested-call record.
        </div>
      )}
      {outputsStored === false && calls.length > 0 && (
        <div className="sub-call-info">
          A reloaded session keeps the calls a subagent made but not what they
          returned — outputs are only readable while it runs.
        </div>
      )}
      {!!reasoning?.length && (
        <ThinkingSection
          turns={reasoning}
          running={running}
          truncated={details.reasoningTruncated}
        />
      )}
      {report && (
        <div className="sub-agent-report">
          <div className="sub-agent-report-label">Report</div>
          <MdRender>{report}</MdRender>
        </div>
      )}
      {(state || meta || subagentHasLog(details)) && (
        <div className="sub-agent-meta">
          <span className="sub-agent-summary">
            {state && (
              <span className={`sub-agent-state is-${state.tone}`}>
                <span className="sub-agent-dot" aria-hidden />
                {state.text}
              </span>
            )}
            {meta && <span className="sub-agent-stats">{meta}</span>}
          </span>
          {subagentHasLog(details) && (
            <Tooltip
              content="Open this run's transcript in the editor"
              side="top"
              align="end">
              <button
                type="button"
                className="exec-action ctl-subagent-log"
                aria-label="Open the subagent transcript"
                onClick={() => actions.openSubagentLog(toolCallId)}>
                <LuFileText aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

function StateGlyph({ status }: { status: ToolExec['status'] }) {
  if (status === 'running')
    return (
      <LoadingPulse variant="pulse" size="sm" className="sub-call-pulse" />
    );
  return status === 'error' ? <LuX aria-hidden /> : <LuCheck aria-hidden />;
}

/**
 * What the child thought, turn by turn, newest kept in view while it runs.
 *
 * A bounded view: pi-subagent ships the newest turns and says when it dropped older ones,
 * because thinking is the cheapest thing on the wire to lose and the most expensive to send
 * whole. The transcript behind the footer's control is the complete record, which is what the
 * truncation note points at.
 */
function ThinkingSection({
  turns,
  running,
  truncated,
}: {
  turns: SubagentReasoningTurn[];
  running: boolean;
  truncated?: boolean;
}) {
  const follow = useStickToBottom<HTMLUListElement>(turns.length, running);
  return (
    <div className="sub-agent-thinking">
      <div className="sub-agent-report-label">Thinking</div>
      <ul
        className="sub-thought-list"
        ref={follow.ref}
        onScroll={follow.onScroll}>
        {turns.map((entry, index) => (
          <ThinkingRow
            key={`${entry.turn}:${index}`}
            entry={entry}
            latest={index === turns.length - 1}
            running={running}
          />
        ))}
      </ul>
      {truncated && (
        <div className="sub-call-info">
          Only the newest thinking is shown — the transcript holds all of it.
        </div>
      )}
    </div>
  );
}

/**
 * One turn's reasoning: a labelled line, expandable to the thought itself.
 *
 * Same idiom as a call row, because it is the same kind of thing — a step the child took, with
 * a body nobody needs while the list is being scanned. The newest one opens itself while the run
 * is going, which is the only thought the reader is watching.
 */
function ThinkingRow({
  entry,
  latest,
  running,
}: {
  entry: SubagentReasoningTurn;
  latest: boolean;
  running: boolean;
}) {
  const redact = useRedact();
  const text = redact(entry.text);
  const [open, setOpen] = useState(latest && running);
  // The preview is the thought's own first line, so it is the censored text — and the body below renders
  // `text` for the same reason: nothing here is ever handed back to the run.
  const preview = oneLine(text.split('\n')[0] ?? '') || 'Thought';
  return (
    <li className={`sub-thought${open ? ' is-open' : ''}`}>
      <div
        className="sub-call-row sub-thought-row sub-call-row-openable"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}>
        <span className="sub-call-state" aria-hidden>
          <LuBrain />
        </span>
        <span className="sub-call-name">
          {entry.turn > 0 ? `Turn ${entry.turn}` : 'Thinking'}
        </span>
        <span className="sub-thought-preview">{preview}</span>
      </div>
      {open && <pre className="sub-call-output sub-thought-body">{text}</pre>}
    </li>
  );
}

function NestedCallRow({
  tool,
  tools,
}: {
  tool: ToolExec;
  tools: Record<string, ToolExec>;
}) {
  const [open, setOpen] = useState(false);
  // Same rule as the card header: only a call pi reported on counts, so a row left
  // `unfinished` in a reloaded history does not hold a timer that shows nothing — and cannot be stopped,
  // because the runtime is no longer running it.
  const live = tool.status === 'running' && tool.startedAt != null;
  const now = useTickingClock(live);
  const children = childCalls(tool, tools);
  const redact = useRedact();
  const preview = toolRowPreview(tool);
  const fullText = toolFullText(tool.toolName, tool.args);
  const result = redact(tool.resultText ?? '');
  const duration = toolDuration(tool, now);
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const images = tool.images;
  const { copied, copy } = useCopyFeedback();
  // Gated on the stored text, not on its censored rendering: a rule that empties an output must not take
  // the row's own disclosure away with it (the body below still renders the censored text).
  const expandable =
    !!tool.resultText || !!images?.length || children.length > 0;
  const hasTip = !!(fullText || preview || tool.resultText);
  // The row's own value, untruncated: the command, the path, the pattern. A nested call is
  // ellipsized to one line exactly like a top-level card, and a row that cannot be reached by
  // keyboard — because its list scrolls inside an open card — needs its Copy control in the open too.
  const copyText = fullText;
  // The same wording the card's own button uses, so a row and its card never describe the same value twice.
  const copyHint = FILE_TOOLS.has(tool.toolName)
    ? 'path'
    : tool.toolName === 'bash'
      ? 'command'
      : 'arguments';

  return (
    <li className={`sub-call sub-call-${tool.status}`}>
      <div
        className={`sub-call-row${expandable ? ' sub-call-row-openable' : ''}`}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }>
        <span className="sub-call-state" aria-hidden>
          <StateGlyph status={tool.status} />
        </span>
        <span className="sub-call-name">{label}</span>
        {/* The row is ellipsized by CSS; the surface carries the whole command and the
            output it produced. Both are cut to a line budget instead of scrolling, and
            the surface is inert, so the rows it covers stay clickable. */}
        <Tooltip
          content={() => (
            <NestedCallTip
              label={label}
              command={tipHead(fullText || preview)}
              output={result}
              isError={tool.isError}
            />
          )}
          side="top"
          align="start"
          className="sub-call-tip"
          disabled={!hasTip}>
          <span className="sub-call-cmd">{preview || '—'}</span>
        </Tooltip>
        {duration && <span className="sub-call-duration">{duration}</span>}
      </div>
      {/* The two command stops, and deliberately not the turn stop: aborting is the outer card's control, and a
          row that cancelled the whole run would read as a way to stop the one command it shows.

          A *sibling* of the row, not a cell inside it: the row is the disclosure and carries `role="button"`,
          and a real button nested in an ARIA button is hidden from the assistive tech that would need to press
          it — and its click would bubble into the toggle, folding the row the stop just opened up. The row is
          a grid, so this costs one grid on the list item instead. */}
      {(live || copyText) && (
        <span className="sub-call-actions">
          {copyText && (
            <Tooltip
              content={copied ? 'Copied' : `Copy the ${copyHint}`}
              side="top"
              align="end">
              <button
                type="button"
                className={`exec-action ctl-row-copy${copied ? ' is-copied' : ''}`}
                aria-label={
                  copied ? 'Copied' : `Copy the ${copyHint} of this call`
                }
                onClick={() => copy(copyText)}>
                {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />}
              </button>
            </Tooltip>
          )}
          {live && (
            <StopActions
              toolCallId={tool.toolCallId}
              name={tool.toolName}
              live
              allowAbort={false}
            />
          )}
        </span>
      )}
      {open && tool.resultText && (
        <pre
          className={`sub-call-output${
            tool.isError ? ' sub-call-output-error' : ''
          }`}>
          {result}
        </pre>
      )}
      {/* The row is this call's disclosure, so it gates the read the same way the card
          does: nothing is fetched for a nested call nobody opened. */}
      {open && images?.length ? (
        <ToolImages
          toolCallId={tool.toolCallId}
          images={images}
          expanded={open}
        />
      ) : null}
      {children.length > 0 && (
        <ul className="sub-call-list sub-call-nested">
          {children.map((child) => (
            <NestedCallRow key={child.toolCallId} tool={child} tools={tools} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Hover body for a nested row: the call in full, then the output it produced.
 *
 * The row itself is one ellipsized line and its output sits behind a click, so this
 * is the "what did that command actually return" glance — with the tail of a long
 * output, because the interesting line of a wall of text is at the end. A reloaded row
 * has no output at all, so its surface carries the command alone.
 */
function NestedCallTip({
  label,
  command,
  output,
  isError,
}: {
  label: string;
  command: string;
  output?: string;
  isError?: boolean;
}) {
  return (
    <>
      <div className="tooltip-text">{command || `${label}: no arguments`}</div>
      {output && (
        <pre className={`sub-call-tip-output${isError ? ' is-error' : ''}`}>
          {tipTail(output)}
        </pre>
      )}
    </>
  );
}
