import { useEffect, useState } from 'react';
import {
  LuBot,
  LuCheck,
  LuChevronRight,
  LuCopy,
  LuSquare,
  LuWrench,
} from 'react-icons/lu';
import { actions } from '../../apis/actions';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { useTickingClock } from '../../hooks/use-ticking-clock';
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
  oneLine,
  statusClass,
  summarize,
  tipHead,
  toolDuration,
  toolFullText,
} from './tool-display';
import {
  SUBAGENT_TITLE,
  SubagentCalls,
  cleanReport,
  resolveSubagentCard,
  subagentPrompt,
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
  /** False for a list that came back from the runtime's persisted record. */
  outputsStored: boolean;
}

export function ExecBlock({ tool, name, args, tools }: ToolCallViewProps) {
  const effectiveArgs = asRecord(tool?.args ?? args);
  const status: ToolStatus = tool?.status ?? 'running';
  const running = status === 'running';
  const result = tool?.resultText ?? '';
  const isError = tool?.isError ?? false;

  // A subagent card is identified by the `details` payload the tool reports, not by
  // its name, so a renamed or third-party subagent tool still renders correctly.
  const subagent = resolveSubagentCard(name, tool?.details, effectiveArgs);
  // The task is what identifies a subagent call, and until now it had no home in the
  // card at all: the header shows one line of it, the tooltip and the copy button the
  // whole text.
  const prompt = subagent ? subagentPrompt(effectiveArgs, subagent) : '';
  const summary = prompt || summarize(name, effectiveArgs);
  const nested = childCalls(tool, tools);
  const report = subagent
    ? (subagent.report ??
      (running ? undefined : cleanReport(result) || undefined))
    : undefined;
  const view: NestedView = {
    subagent,
    nested,
    tools: tools ?? {},
    report,
    nestedComplete: tool?.nestedComplete,
    outputsStored: !tool?.nestedFromRecord,
  };

  // Whether pi is really executing this call right now. A card built from a tool call
  // the runtime never reported on — one a sequential batch skipped, an `unfinished`
  // record reloaded from history — has no clock, and giving it a Stop button would
  // abort whatever the agent happens to be running instead.
  const live =
    running && (tool?.startedAt != null || subagent?.elapsedMs != null);

  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(
    null,
  );
  const defaultExpanded = status !== 'done' || isError;
  const expanded = expandedOverride ?? defaultExpanded;
  const now = useTickingClock(live);
  const { copied, copy } = useCopyFeedback();
  const [stopRequested, setStopRequested] = useState(false);

  // pi settles the call itself (an aborted tool comes back as an error result), so
  // the flag only has to keep the button from looking pressable in the meantime.
  useEffect(() => {
    if (!running) setStopRequested(false);
  }, [running]);

  const Icon = subagent ? LuBot : (TOOL_ICONS[name] ?? LuWrench);
  const label = subagent ? SUBAGENT_TITLE : (TOOL_LABELS[name] ?? name);
  const displaySummary = subagent
    ? oneLine(summary)
    : FILE_TOOLS.has(name) && summary
      ? basename(summary)
      : summary;
  // Elapsed time on every card, counting live while the call runs (from its own
  // `startedAt`, or from the subagent's `elapsedMs` progress field when it has one).
  const duration = toolDuration(tool, now, subagent?.elapsedMs);
  // The untruncated command, path or task: the header ellipsizes it, so this is the
  // only way to hand a long value to a shell elsewhere.
  const copyText = prompt || toolFullText(name, effectiveArgs);
  const copyHint =
    subagent && prompt
      ? 'prompt'
      : FILE_TOOLS.has(name)
        ? 'path'
        : name === 'bash'
          ? 'command'
          : 'arguments';
  const toggle = () => setExpandedOverride(!expanded);

  // pi has no per-tool cancel: `abort` cancels the run's signal, which the running
  // tool observes (or ignores until it settles) — the composer's Stop button, placed
  // on the call you are actually watching.
  const stop = () => {
    if (stopRequested) return;
    setStopRequested(true);
    actions.abort();
  };

  return (
    <div
      className={`exec-block ${statusClass(status)}${isError ? ' error' : ''}`}
      {...(expanded ? ({ open: true } as Record<string, unknown>) : {})}>
      <div className="exec-header">
        {/* The disclosure is the summary, not the whole row: the row also carries the
            action buttons, and nesting them in a `role="button"` row would hide them
            from assistive tech. On a subagent card the hover tooltip on that same
            surface carries the task in full, which has nowhere else to be read. */}
        <Tooltip
          content={subagent && prompt ? tipHead(prompt) : ''}
          side="bottom"
          align="start"
          gap={4}
          className="subagent-prompt-tip">
          <button
            type="button"
            className="exec-summary"
            aria-expanded={expanded}
            onClick={toggle}
            title={subagent ? undefined : summary || undefined}>
            <Icon className="exec-type-icon" aria-hidden />
            <span className="exec-name">{label}</span>
            {displaySummary && (
              <span className="exec-summary-text">{displaySummary}</span>
            )}
          </button>
        </Tooltip>
        {(duration || copyText || live) && (
          <span className="exec-actions">
            {duration && <span className="tool-duration">{duration}</span>}
            {copyText && (
              <Tooltip
                content={copied ? 'Copied' : `Copy ${copyHint}`}
                side="bottom"
                align="end">
                <button
                  type="button"
                  className={`exec-action${copied ? ' is-copied' : ''}`}
                  aria-label={copied ? 'Copied' : `Copy the ${copyHint}`}
                  onClick={() => copy(copyText)}>
                  {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />}
                </button>
              </Tooltip>
            )}
            {live && (
              <Tooltip
                content={stopRequested ? 'Stopping…' : 'Stop'}
                side="bottom"
                align="end">
                {/* `aria-disabled` rather than `disabled`: Chromium stops dispatching
                    mouse events to a disabled control, which would strand its own
                    open tooltip and hide the "Stopping…" confirmation. */}
                <button
                  type="button"
                  className={`exec-action exec-action-stop${stopRequested ? ' is-stopped' : ''}`}
                  aria-label="Stop this tool call"
                  aria-disabled={stopRequested || undefined}
                  onClick={stop}>
                  <LuSquare aria-hidden />
                </button>
              </Tooltip>
            )}
          </span>
        )}
        <span className="exec-chevron" aria-hidden>
          <LuChevronRight />
        </span>
      </div>
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
        outputsStored={view.outputsStored}
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
