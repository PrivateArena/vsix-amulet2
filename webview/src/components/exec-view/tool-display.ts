/**
 * Display layer for tool calls: label, icon, one-line argument preview and
 * duration formatting.
 *
 * Shared by the tool card header (`tool-call-view.tsx`) and the nested-call rows
 * of a subagent card, so a call made by another tool reads exactly like a
 * top-level one. Lives here rather than in the component file so neither side
 * has to import the other (the card renders these rows).
 */
import type { ComponentType } from 'react';
import {
  LuEye,
  LuFilePen,
  LuFolderOpen,
  LuPencil,
  LuSearch,
  LuTerminal,
} from 'react-icons/lu';
import type { IconBaseProps } from 'react-icons';
import type { ToolExec } from '../../store';

export const TOOL_ICONS: Record<string, ComponentType<IconBaseProps>> = {
  bash: LuTerminal,
  read: LuEye,
  write: LuFilePen,
  edit: LuPencil,
  grep: LuSearch,
  find: LuFolderOpen,
  ls: LuFolderOpen,
};

export const TOOL_LABELS: Record<string, string> = {
  bash: 'Terminal',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Search',
  find: 'Find',
  ls: 'List',
};

export const FILE_TOOLS = new Set(['read', 'write', 'edit']);

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** One-line argument preview, keyed by what identifies the call per tool. */
export function summarize(name: string, args: Record<string, unknown>): string {
  const first = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  };
  switch (name) {
    case 'bash':
      return first('command', 'cmd');
    case 'read':
    case 'write':
    case 'edit':
      return first('path', 'file', 'filePath', 'file_path');
    case 'grep':
    case 'find':
      return first('pattern', 'query', 'path');
    case 'ls':
      return first('path', 'dir') || '.';
    default:
      // `task` is what a subagent-style call carries, and it is the only argument
      // worth a preview there.
      return first(
        'path',
        'file',
        'command',
        'pattern',
        'query',
        'url',
        'task',
      );
  }
}

export function basename(p: string): string {
  const clean = p.replace(/[/\\]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function statusClass(status: string): string {
  switch (status) {
    case 'running':
      return 'pending';
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

/**
 * Human duration as used by the tool headers: `formatDuration(640) === '<1s'`,
 * `formatDuration(13000) === '13s'`, `formatDuration(75000) === '1m 15s'`.
 */
export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Under this a call is too fast to be worth a duration badge, live or settled. */
const MIN_BADGED_DURATION_MS = 1000;

/**
 * Duration badge for any tool row — not only the subagent card that introduced it.
 *
 * While the call runs it counts up from `startedAt` (or from the tool's own progress
 * estimate, `elapsedMs`, which is why a caller may pass `preferredMs`); once it
 * settles it is the runtime's measured `durationMs`. Nothing shows under a second,
 * live or settled: nearly every read and edit lands there, and a badge that flashes
 * up and then disappears is worse than none.
 */
export function toolDuration(
  tool: ToolExec | undefined,
  now: number,
  preferredMs?: number,
): string {
  const ms = toolElapsed(tool, now, preferredMs);
  if (ms == null || ms < MIN_BADGED_DURATION_MS) return '';
  return formatDuration(ms);
}

/** How long a call has taken (or took), or undefined when nothing reported it. */
function toolElapsed(
  tool: ToolExec | undefined,
  now: number,
  preferredMs?: number,
): number | undefined {
  if (!tool) return undefined;
  if (tool.status === 'running') {
    if (preferredMs != null) return preferredMs;
    return tool.startedAt == null
      ? undefined
      : Math.max(0, now - tool.startedAt);
  }
  return tool.durationMs ?? preferredMs;
}

/** Collapse a multi-line value to one line; CSS does the ellipsis after that. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** Single-line preview for a row: newlines and indent collapse, CSS does the ellipsis. */
export function toolPreview(name: string, args: unknown): string {
  return oneLine(summarize(name, asRecord(args)));
}

/**
 * Untruncated argument text for the hover tooltip — the command or path exactly as
 * the model wrote it, falling back to the compact JSON of the whole argument object.
 */
export function toolFullText(name: string, args: unknown): string {
  const record = asRecord(args);
  const preview = summarize(name, record);
  if (preview) return preview;
  if (typeof args === 'string') return args;
  const keys = Object.keys(record);
  if (!keys.length) return '';
  try {
    return JSON.stringify(record, null, 2) ?? '';
  } catch {
    return keys.join(', ');
  }
}

/** A row's preview plus the reason when pi omitted the arguments from its record. */
export function toolRowPreview(tool: ToolExec): string {
  const preview = toolPreview(tool.toolName, tool.args);
  if (preview) return preview;
  return tool.argsOmittedBytes
    ? `[arguments omitted, ${tool.argsOmittedBytes} bytes]`
    : '';
}

/**
 * Budgets for hover text. A tooltip surface cannot be scrolled — it is inert, so the
 * pointer reaches whatever it covers instead (see `.sub-call-tip` / `.subagent-prompt-tip`
 * in the cards' SCSS) — so what does not fit is simply not shown, and the line count is
 * what keeps the surface inside the window.
 */
export const TIP_TAIL_LINES = 14;
export const TIP_TAIL_CHARS = 1200;
export const TIP_HEAD_LINES = 14;
export const TIP_HEAD_CHARS = 1200;

/**
 * Tail of a call's output for the hover tooltip: the end is where the error or the
 * result line is, so the head is what gets cut.
 */
export function tipTail(
  text: string,
  maxLines = TIP_TAIL_LINES,
  maxChars = TIP_TAIL_CHARS,
): string {
  const lines = text.split('\n');
  let out = lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
  if (out.length > maxChars) out = out.slice(-maxChars);
  if (out.length >= text.length) return text;
  return `… ${text.length - out.length} earlier chars …\n${out}`;
}

/**
 * Head of a command or task, for the same surface. Cutting the end of a command or of a
 * prompt is honest, cutting its start would not be, so this is the mirror of
 * {@link tipTail} — and the card's Copy button is how you get the rest.
 */
export function tipHead(
  text: string,
  maxLines = TIP_HEAD_LINES,
  maxChars = TIP_HEAD_CHARS,
): string {
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  let out =
    lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : trimmed;
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  if (out.length >= trimmed.length) return trimmed;
  return `${out}\n… ${trimmed.length - out.length} more chars …`;
}

/** Rows a call list renders, counting the nested ones: the list's "newest content" signal. */
export function countCallRows(
  calls: ToolExec[],
  tools: Record<string, ToolExec>,
): number {
  return calls.reduce(
    (total, call) => total + 1 + countCallRows(childCalls(call, tools), tools),
    0,
  );
}

/** Direct nested calls of `tool`, in the order they were made. */
export function childCalls(
  tool: ToolExec | undefined,
  tools: Record<string, ToolExec> | undefined,
): ToolExec[] {
  if (!tool?.childIds || !tools) return [];
  return tool.childIds.flatMap((id) => {
    const child = tools[id];
    return child ? [child] : [];
  });
}
