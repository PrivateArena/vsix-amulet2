import { useState } from 'react';
import { LuBot, LuChevronRight, LuWrench } from 'react-icons/lu';
import type { ToolExec, ToolStatus } from '../../store';
import { PatchView } from '../patch-view';
import { CodeBlock } from '../code-block';
import { Tooltip } from '../ui/tooltip';
import {
  FILE_TOOLS,
  TOOL_ICONS,
  TOOL_LABELS,
  asRecord,
  basename,
  childCalls,
  formatDuration,
  statusClass,
  summarize,
} from './tool-display';
import {
  SUBAGENT_TITLE,
  SubagentCalls,
  cleanReport,
  resolveSubagentCard,
  type SubagentDetailsView,
} from './subagent-calls';
import './exec-block-view.scss';

interface ToolCallViewProps {
  tool: ToolExec | undefined;
  name: string;
  args?: unknown;
  /**
   * The session's whole tool map. A card needs it to look up the calls this tool
   * made through `ctx.executeTool()` — subagent commands, codemode calls.
   */
  tools?: Record<string, ToolExec>;
}

function extractEdits(
  args: Record<string, unknown>,
): { oldText: string; newText: string }[] {
  if (Array.isArray(args.edits)) {
    return (args.edits as any[])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        oldText: String(e.oldText ?? ''),
        newText: String(e.newText ?? ''),
      }));
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return [];
}

interface NestedView {
  /** Non-null when this tool is a subagent call (recognised by its `details`). */
  subagent: SubagentDetailsView | null;
  /** Calls this tool made, in arrival order. */
  nested: ToolExec[];
  tools: Record<string, ToolExec>;
  report?: string;
  nestedComplete?: boolean;
}

export function ExecBlock({ tool, name, args, tools }: ToolCallViewProps) {
  const effectiveArgs = asRecord(tool?.args ?? args);
  const status: ToolStatus = tool?.status ?? 'running';
  const summary = summarize(name, effectiveArgs);
  const result = tool?.resultText ?? '';
  const isError = tool?.isError ?? false;

  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );
  const defaultExpanded = status !== 'done' || isError;
  const expanded = expandedOverride ?? defaultExpanded;

  // A subagent card is identified by the `details` payload the tool reports, not by
  // its name, so a renamed or third-party subagent tool still renders correctly.
  const subagent = resolveSubagentCard(name, tool?.details, effectiveArgs);
  const nested = childCalls(tool, tools);
  const report = subagent
    ? (subagent.report ??
      (status === 'running' ? undefined : cleanReport(result) || undefined))
    : undefined;
  const view: NestedView = {
    subagent,
    nested,
    tools: tools ?? {},
    report,
    nestedComplete: tool?.nestedComplete,
  };

  const Icon = subagent ? LuBot : (TOOL_ICONS[name] ?? LuWrench);
  const label = subagent ? SUBAGENT_TITLE : (TOOL_LABELS[name] ?? name);
  const displaySummary =
    !subagent && FILE_TOOLS.has(name) && summary ? basename(summary) : summary;
  // While running, the elapsed time comes from the tool's own progress heartbeat.
  const duration = subagent
    ? formatDuration(tool?.durationMs ?? subagent.elapsedMs)
    : '';

  return (
    <div
      className={`exec-block ${statusClass(status)}${isError ? ' error' : ''}`}
      {...(expanded ? ({ open: true } as Record<string, unknown>) : {})}>
      <button
        className="exec-header"
        onClick={() => setExpandedOverride(!expanded)}
        // A subagent card shows the full task in a styled tooltip instead.
        title={subagent ? undefined : summary || undefined}
        type="button">
        <Icon className="exec-type-icon" aria-hidden />
        <span className="exec-name">{label}</span>
        {displaySummary &&
          (subagent ? (
            <Tooltip
              content={summary || displaySummary}
              side="bottom"
              align="start">
              <span className="exec-summary-text">{displaySummary}</span>
            </Tooltip>
          ) : (
            <span className="exec-summary-text">{displaySummary}</span>
          ))}
        {duration && <span className="tool-duration">{duration}</span>}
        <span className="exec-chevron" aria-hidden>
          <LuChevronRight />
        </span>
      </button>
      {/* Always mounted so collapsing can animate; the grid wrapper drives
          the height transition, the scroll layer keeps output scrollable. */}
      <div className="exec-content-wrap" aria-hidden={!expanded}>
        <div className="exec-content">
          <div className="exec-scroll">
            {renderBody(name, effectiveArgs, result, status, isError, view)}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderBody(
  name: string,
  args: Record<string, unknown>,
  result: string,
  status: ToolStatus,
  isError: boolean,
  view: NestedView,
) {
  // Any tool that ran other tools gets the same nested list, subagent or not.
  if (view.subagent || view.nested.length > 0) {
    return (
      <SubagentCalls
        calls={view.nested}
        tools={view.tools}
        details={view.subagent ?? {}}
        report={view.report}
        status={status}
        complete={view.nestedComplete}
      />
    );
  }
  if (name === 'bash') {
    return (
      <>
        {typeof args.command === 'string' && (
          <pre className="exec-bash">$ {String(args.command)}</pre>
        )}
        {result && (
          <pre
            className={`exec-output exec-bash-out${isError ? ' exec-output-error' : ''}`}>
            {result}
          </pre>
        )}
        {!result && status === 'running' && (
          <div className="exec-running">Running…</div>
        )}
      </>
    );
  }
  if (name === 'edit') {
    const edits = extractEdits(args);
    return (
      <>
        <div className="exec-edit">
          <PatchView edits={edits} />
        </div>
        {isError && result && (
          <pre className="exec-output exec-output-error">{result}</pre>
        )}
      </>
    );
  }
  if (name === 'read') {
    if (result && !isError) {
      return (
        <CodeBlock
          code={result}
          path={summarize('read', args)}
          className="exec-output exec-output-code"
        />
      );
    }
    if (result) {
      return <pre className="exec-output exec-output-error">{result}</pre>;
    }
    return status === 'running' ? (
      <div className="exec-running">Reading…</div>
    ) : null;
  }
  if (name === 'write' && typeof args.content === 'string') {
    return (
      <>
        <div className="exec-write">
          <PatchView edits={[{ oldText: '', newText: args.content }]} />
        </div>
        {isError && result && (
          <pre className="exec-output exec-output-error">{result}</pre>
        )}
      </>
    );
  }
  return (
    <>
      {Object.keys(args).length > 1 && (
        <pre className="exec-args">{JSON.stringify(args, null, 2)}</pre>
      )}
      {result ? (
        <pre className={`exec-output${isError ? ' exec-output-error' : ''}`}>
          {result}
        </pre>
      ) : status === 'running' ? (
        <div className="exec-running">Running…</div>
      ) : null}
    </>
  );
}
