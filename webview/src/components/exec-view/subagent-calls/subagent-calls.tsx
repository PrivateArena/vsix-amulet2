import { useState } from 'react';
import { LuCheck, LuX } from 'react-icons/lu';
import type { ToolExec } from '../../../store';
import { useStickToBottom } from '../../../hooks/use-stick-to-bottom';
import { useTickingClock } from '../../../hooks/use-ticking-clock';
import { MdRender } from '../../md-render';
import { LoadingPulse } from '../../ui/ld';
import { Tooltip } from '../../ui/tooltip';
import {
  TOOL_LABELS,
  childCalls,
  countCallRows,
  tipHead,
  tipTail,
  toolDuration,
  toolFullText,
  toolRowPreview,
} from '../tool-display';
import { subagentMetaLine, type SubagentDetailsView } from './subagent-details';
import './subagent-calls.scss';

export interface SubagentCallsProps {
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
 * Body of a subagent card: the calls the child made (live, streamed), then its
 * report. Every nested call arrives as its own `tool_execution_*` event carrying
 * `parentToolCallId`, so rows get real arguments, per-call duration and — while the
 * run is live — the call's output for expansion.
 */
export function SubagentCalls({
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
  // The list grows while the child works, and the interesting row is always the last
  // one — so it follows the calls, until the reader scrolls up to look at something.
  // A finished card keeps no such grip: opened later, it reads from the top.
  const follow = useStickToBottom<HTMLUListElement>(
    countCallRows(calls, tools ?? {}),
    running,
  );

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
      ) : (
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
      {report && (
        <div className="sub-agent-report">
          <div className="sub-agent-report-label">Report</div>
          <MdRender>{report}</MdRender>
        </div>
      )}
      {meta && <div className="sub-agent-meta">{meta}</div>}
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

function NestedCallRow({
  tool,
  tools,
}: {
  tool: ToolExec;
  tools: Record<string, ToolExec>;
}) {
  const [open, setOpen] = useState(false);
  // Same rule as the card header: only a call pi reported on counts, so a row left
  // `unfinished` in a reloaded history does not hold a timer that shows nothing.
  const now = useTickingClock(
    tool.status === 'running' && tool.startedAt != null,
  );
  const children = childCalls(tool, tools);
  const preview = toolRowPreview(tool);
  const fullText = toolFullText(tool.toolName, tool.args);
  const duration = toolDuration(tool, now);
  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const expandable = !!tool.resultText || children.length > 0;
  const hasTip = !!(fullText || preview || tool.resultText);

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
              output={tool.resultText}
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
      {open && tool.resultText && (
        <pre
          className={`sub-call-output${
            tool.isError ? ' sub-call-output-error' : ''
          }`}>
          {tool.resultText}
        </pre>
      )}
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
