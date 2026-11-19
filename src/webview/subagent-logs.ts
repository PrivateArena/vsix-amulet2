/**
 * Where a subagent run's own files live, and which one a click may open.
 *
 * A child session is not a process and not a session of this runtime: it writes its own transcript
 * (`<parent session dir>/subagent/<stamp>_<id>.jsonl`, whole thinking included) and — when
 * `subagent.debugLog` is on — one harness log per run (`<tmp>/pi-subagent/<stamp>_<role>_<id>.jsonl`).
 * Both paths are reported by pi-subagent inside the tool's `details`, on every progress update and again
 * on the settled result, so the host is the only party that ever has to read them off the wire.
 *
 * That is the whole reason this file exists: a card must not be able to name a file. The webview sends
 * the parent `subagent` tool call id, and the click resolves against the pairs recorded here — the same
 * rule `src/prompts/prompt-resource.ts` applies to a template path, and the reason no `path` field rides
 * on the {@link WebviewMessage} that asks for the transcript.
 */
import * as fs from 'node:fs';
import type { HistoryMessage, RpcEvent } from '../../shared/protocol';

/** The two files one subagent run leaves behind; either can be absent. */
export interface SubagentLogPaths {
  /** The child's own transcript: the complete conversation, thinking included. */
  transcript?: string;
  /** pi-subagent's harness log of the run, with its budget and exit lines. */
  log?: string;
}

/**
 * How many runs one bridge remembers paths for. A long session spawns dozens of children and nobody can
 * open a transcript from a card that scrolled away, so the oldest entries are dropped well before the map
 * could matter next to the session it describes.
 */
export const MAX_TRACKED_SUBAGENT_LOGS = 256;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The two paths a subagent `details` payload reports, or nothing when it reports neither.
 *
 * Deliberately not a "is this a subagent card" test: the only question asked here is which file a click
 * should open, and a card that never names a file simply gets no control. An older pi-subagent reports
 * `childSessionFile` on the settled result only, which is exactly as much of the feature as that runtime
 * can honour.
 */
export function readSubagentLogPaths(
  details: unknown,
): SubagentLogPaths | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const raw = details as Record<string, unknown>;
  const transcript = str(raw.childSessionFile);
  const log = str(raw.turnLogFile);
  if (!transcript && !log) return undefined;
  // Only the fields that exist: an explicit `undefined` would overwrite a path already recorded for the
  // same call, and the settled result reports one file while a progress update reported the other.
  return {
    ...(transcript ? { transcript } : {}),
    ...(log ? { log } : {}),
  };
}

/**
 * The one file that stands for "what the subagent did": its transcript. The harness log is the fallback
 * for a run whose transcript never appeared, and nothing at all when the runtime reported no path — a
 * control that opens the wrong file is worse than one that is missing.
 */
export function pickSubagentLog(
  paths: SubagentLogPaths | undefined,
): string | undefined {
  return paths?.transcript ?? paths?.log;
}

/**
 * A transcript path is opened only as itself: a real file, with the extension every pi session and run log
 * uses. This is not a sandbox — the value came off the wire, not out of a webview input — it is the check
 * that a stale path, a deleted file, or a payload that named something else fails quietly instead of
 * opening a buffer nobody asked for.
 */
export function isReadableLogfile(filePath: string): boolean {
  if (!filePath.toLowerCase().endsWith('.jsonl')) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function empty(paths: SubagentLogPaths | undefined): boolean {
  return !paths || (!paths.transcript && !paths.log);
}

/**
 * One bridge's record of which tool call wrote which files, fed by the events it forwards and by the
 * history it pushes, so a card reloaded into a fresh window can still be opened.
 *
 * Per bridge rather than per runtime, like everything else here: the paths are the same for every surface
 * and the map is a few strings, while a shared registry would outlive the session it describes (bridges
 * come and go with the surfaces, sessions switch under them).
 */
export class SubagentLogIndex {
  private readonly paths = new Map<string, SubagentLogPaths>();

  /** Record what one `details` payload says. Returns whether this call is newly known. */
  note(toolCallId: string, details: unknown): boolean {
    const next = readSubagentLogPaths(details);
    if (!next) return false;
    const known = this.paths.has(toolCallId);
    // Newest wins, and the freshest payload is the fullest one: a progress update can carry the log path
    // before the transcript exists, and the settled result carries both.
    this.paths.set(toolCallId, { ...this.paths.get(toolCallId), ...next });
    this.evict();
    return !known;
  }

  /** Seed from a history snapshot, whose `toolResult` rows carry the settled `details`. */
  seed(messages: readonly HistoryMessage[]): void {
    for (const message of messages as readonly unknown[]) {
      const row = message as {
        role?: string;
        toolCallId?: unknown;
        details?: unknown;
      };
      if (row?.role !== 'toolResult' || typeof row.toolCallId !== 'string')
        continue;
      this.note(row.toolCallId, row.details);
    }
  }

  pathsOf(toolCallId: string): SubagentLogPaths | undefined {
    const found = this.paths.get(toolCallId);
    return empty(found) ? undefined : found;
  }

  clear(): void {
    this.paths.clear();
  }

  /** Insertion order is call order, so the front of the map is the run nobody can reach any more. */
  private evict(): void {
    while (this.paths.size > MAX_TRACKED_SUBAGENT_LOGS) {
      const oldest = this.paths.keys().next();
      if (oldest.done) return;
      this.paths.delete(oldest.value);
    }
  }
}

/**
 * Note the files reported by a tool event, if it reports any. Both the live progress payload and the
 * settled result pass through here, and every other tool call falls straight through — a `bash` result has
 * no `details`, so nothing is stored for it.
 */
export function noteSubagentEventLogs(
  index: SubagentLogIndex,
  event: RpcEvent,
): void {
  const call = event as {
    toolCallId?: unknown;
    partialResult?: { details?: unknown };
    result?: { details?: unknown };
  };
  if (typeof call.toolCallId !== 'string') return;
  const details =
    event.type === 'tool_execution_end'
      ? call.result?.details
      : call.partialResult?.details;
  if (details === undefined) return;
  index.note(call.toolCallId, details);
}
