import { asToolCall, normalizeContent } from '../../shared/blocks';
import { CONTEXT_OMIT_PLACEHOLDER } from '../../shared/bridge-protocol';
import type {
  AppMessage,
  HistoryMessage,
  ToolResultMessage,
} from '../../shared/protocol';
import type { ContextEditRecord } from '../session/session-store';

/**
 * Repairing the history snapshot for what the model can no longer re-read.
 *
 * `get_messages` answers with pi's *model-context projection* — the same list the child is about to
 * send. That is exactly the wrong list to paint: an omitted tool result is **absent** from it, so the
 * card would vanish from a transcript the user never deleted, and a replaced one reads as the real
 * output. Neither is recoverable inside the webview, which cannot see the session file.
 *
 * So the host re-inserts what the projection dropped, from the durable `context_edit` entries it can
 * read (`readBranchContextEdits`), and tells the reducer which ids are replaced. The transcript shows
 * the original text with a badge; the model keeps getting the edited view.
 */

/** A history row as it really arrives: `get_messages` interleaves tool results with the chat roles. */
type HistoryRow = AppMessage | ToolResultMessage;

function rows(messages: HistoryMessage[]): HistoryRow[] {
  return messages as unknown as HistoryRow[];
}

function isToolResult(row: HistoryRow): row is ToolResultMessage {
  return (
    (row as { role?: string }).role === 'toolResult' &&
    typeof (row as ToolResultMessage).toolCallId === 'string'
  );
}

/** The assistant row that asked for one call, and where in that reply the call sat. */
interface OwningCall {
  /** Index of the assistant row in the snapshot. */
  index: number;
  /** Position among that reply's tool calls, which is the order the results come back in. */
  order: number;
  /** Every call the reply made, in order — enough to place a sibling result. */
  callIds: string[];
  toolName: string;
}

function ownerOf(
  messages: HistoryMessage[],
  toolCallId: string,
): OwningCall | undefined {
  const list = rows(messages);
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if ((row as { role?: string }).role !== 'assistant' || !('content' in row))
      continue;
    const calls = normalizeContent(row.content)
      .map((block) => asToolCall(block))
      .filter(
        (call): call is NonNullable<ReturnType<typeof asToolCall>> => !!call,
      );
    const order = calls.findIndex((call) => call.id === toolCallId);
    if (order < 0) continue;
    return {
      index: i,
      order,
      callIds: calls.map((call) => call.id),
      toolName: calls[order].name,
    };
  }
  return undefined;
}

/** The tool results that survived directly after `assistantIndex`, in call order. */
function survivingSiblings(
  messages: HistoryMessage[],
  assistantIndex: number,
): { index: number; toolCallId: string }[] {
  const list = rows(messages);
  const out: { index: number; toolCallId: string }[] = [];
  for (let i = assistantIndex + 1; i < list.length; i++) {
    const row = list[i];
    if (isToolResult(row)) {
      out.push({ index: i, toolCallId: row.toolCallId });
      continue;
    }
    // A compaction boundary or any other non-chat row does not end the run of results.
    if ((row as { role?: string }).role === 'assistant') break;
    if ((row as { role?: string }).role === 'user') break;
  }
  return out;
}

/** The result of an omitted call, rebuilt from what the session file still holds. */
function restoredResult(
  record: ContextEditRecord,
  toolName: string,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: record.originalToolCallId as string,
    toolName,
    content: [{ type: 'text', text: record.originalText }],
    // A failed call must not come back as a green card after a reload.
    isError: record.originalIsError,
  };
}

/** Whether this result row is the bridge's placeholder for an omission rather than a real output. */
function isOmittedPlaceholder(row: ToolResultMessage): boolean {
  const content = row.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              (block as { type?: string; text?: string })?.type === 'text'
                ? ((block as { text?: string }).text ?? '')
                : '',
            )
            .join('')
            .trim()
        : '';
  return text === CONTEXT_OMIT_PLACEHOLDER;
}

/**
 * Put the real outputs back where the projection shows the model's view instead.
 *
 * Two shapes of the same fact. Normally the durable entry replaced the result's content with the
 * bridge's placeholder, so the row **is** there and only needs its text restored in place. A row can
 * also be gone outright — pi's own final-attempt recovery omits a whole turn with `replacement: null`,
 * and a compaction can eat the reply around it — and then the row is re-inserted at the position its
 * call was made in.
 *
 * Copy-on-change: an unedited session returns the very array it was handed, because the webview
 * compares snapshots by identity. A result whose owning reply is not in the snapshot at all is left out
 * rather than stapled somewhere arbitrary — the accompanying `contextEdits` push still says why.
 */
export function restoreOmittedToolResults(
  messages: HistoryMessage[],
  edits: ContextEditRecord[],
): HistoryMessage[] {
  const omitted = edits.filter(
    (edit) => edit.kind === 'omitted' && !!edit.originalToolCallId,
  );
  if (!omitted.length) return messages;

  const list = rows(messages);
  const substitutions = new Map<number, ContextEditRecord>();
  const missing: ContextEditRecord[] = [];
  for (const record of omitted) {
    const toolCallId = record.originalToolCallId as string;
    const index = list.findIndex(
      (row) => isToolResult(row) && row.toolCallId === toolCallId,
    );
    if (index < 0) {
      missing.push(record);
      continue;
    }
    // Only a stub is rewritten. A row that already carries something else is either the real output
    // (a restore the projection has not applied yet) or text the user typed on purpose.
    const row = list[index] as ToolResultMessage;
    if (isOmittedPlaceholder(row)) substitutions.set(index, record);
  }

  const insertions: { index: number; order: number; row: HistoryMessage }[] =
    [];
  for (const record of missing) {
    const toolCallId = record.originalToolCallId as string;
    const owner = ownerOf(messages, toolCallId);
    if (!owner) continue;
    const siblings = survivingSiblings(messages, owner.index);
    // Results come back in the order the reply asked for them, so an omitted one lands where it was,
    // not at the end of the run.
    const later = siblings.find(
      (sibling) => owner.callIds.indexOf(sibling.toolCallId) > owner.order,
    );
    const at = later
      ? later.index
      : siblings.length
        ? siblings[siblings.length - 1].index + 1
        : owner.index + 1;
    insertions.push({
      index: at,
      order: owner.order,
      row: restoredResult(record, owner.toolName) as unknown as HistoryMessage,
    });
  }
  if (!insertions.length && !substitutions.size) return messages;
  const out = [...messages];
  for (const [index, record] of substitutions) {
    const row = list[index] as ToolResultMessage;
    out[index] = {
      ...row,
      content: [{ type: 'text', text: record.originalText }],
    } as unknown as HistoryMessage;
  }
  // Descending index so an earlier splice cannot move the row a later one was computed against; and
  // descending order within one index, so a whole omitted run lands back in call order, not reversed.
  for (const insertion of insertions.sort(
    (a, b) => b.index - a.index || b.order - a.order,
  )) {
    out.splice(insertion.index, 0, insertion.row);
  }
  return out;
}
