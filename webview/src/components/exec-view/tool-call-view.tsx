import { useEffect, useMemo, useState } from 'react';
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
import { useStreamingToolArgs } from '../../hooks/use-streaming-tool-args';
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
import { WriteStream, writeLineBadge } from './write-stream';
import './exec-block-view.scss';

interface ToolCallViewProps {
  /** The runtime's record of this call; absent while the model is still producing it. */
  tool?: ToolExec;
  name: string;
  args?: unknown;
  /**
   * Raw argument text of a call the model is still producing (see
   * `useStreamingToolArgs`). The runtime has not started executing it yet, so a card with
   * one is a preview rather than a live call.
   */
  partialArgs?: string;
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

export function ExecBlock({
  tool,
  name,
  args,
  partialArgs,
  tools,
}: ToolCallViewProps) {
  // While the model is still typing the call, the arguments on screen are the ones
  // recovered from the streamed JSON buffer, and `typing` is the matching state of that
  // same frame. Once the runtime reports the call, its parsed arguments take over.
  const { args: streamedArgs, typing } = useStreamingToolArgs(partialArgs);
  const effectiveArgs = asRecord(tool?.args ?? args ?? streamedArgs);
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
  const writeContent =
    name === 'write' && typeof effectiveArgs.content === 'string'
      ? effectiveArgs.content
      : '';
  // A write is the one call whose argument is a whole artefact, so the card counts it: the
  // figure grows while the body streams and then describes the file. Nothing is claimed
  // about a call that failed. Counted in a memo — the streamed body is re-parsed per
  // rendered frame, and a whole-file line count has no business running on the renders that
  // add nothing to it.
  const hasSubagent = subagent != null;
  const writeCount = useMemo(
    () =>
      name === 'write' && !hasSubagent && !isError
        ? writeLineBadge(writeContent)
        : '',
    [name, hasSubagent, isError, writeContent],
  );
  // The untruncated command, path or task: the header ellipsizes it, so this is the
  // only way to hand a long value to a shell elsewhere. While the model is still typing
  // the arguments there is nothing worth copying out of them yet.
  const copyText = typing ? '' : prompt || toolFullText(name, effectiveArgs);
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
      className={`exec-block ${statusClass(status)}${isError ? ' error' : ''}${name === 'write' ? ' exec-write' : ''}`}
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
        {(duration || copyText || live || writeCount) && (
          <span className="exec-actions">
            {writeCount && (
              <span className="exec-write-counts">{writeCount}</span>
            )}
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
            <ToolBody
              name={name}
              args={effectiveArgs}
              result={result}
              status={status}
              isError={isError}
              view={view}
              typing={typing}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

interface BodyProps {
  name: string;
  args: Record<string, unknown>;
  result: string;
  status: ToolStatus;
  isError: boolean;
  view: NestedView;
  /** True while the model is still typing the arguments of this call. */
  typing: boolean;
}

function ToolBody({
  name,
  args,
  result,
  status,
  isError,
  view,
  typing,
}: BodyProps) {
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
          <div className="exec-running">{typing ? 'Typing…' : 'Running…'}</div>
        )}
      </>
    );
  }
  if (name === 'edit') {
    // While the model is still typing the replacement, the last edit is by definition
    // unfinished, and a truncated `oldText` is not a deletion. pi defers its own edit
    // preview to `argsComplete` for the same reason: there is no honest diff yet.
    if (typing) {
      return <div className="exec-running">Writing replacement…</div>;
    }
    return (
      <>
        <div className="exec-edit">
          <PatchView edits={extractEdits(args)} />
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
      <div className="exec-running">{typing ? 'Typing…' : 'Reading…'}</div>
    ) : null;
  }
  if (name === 'write' && typeof args.content === 'string') {
    // A running write is the stream itself: pi reports nothing while the tool runs, so the
    // call's own arguments are all of the file there is — shown as the additions-only body
    // the finished card will show, newest line kept in view.
    if (status === 'running') {
      return <WriteStream content={args.content} streaming={typing} />;
    }
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
        <div className="exec-running">{typing ? 'Typing…' : 'Running…'}</div>
      ) : null}
    </>
  );
}
