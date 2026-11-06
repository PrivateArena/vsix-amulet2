/**
 * Turning what the UI can name (a tool call, a line of user text) into what pi can address: the ids of
 * entries on the active branch.
 *
 * The webview has no entry ids for a live card — `get_messages` answers with the model-context
 * projection, and those messages carry no id — while reading the session file from the host would race
 * pi's live leaf. This runs inside the child, where the branch is already in memory.
 */

import type {
  BridgeErrorCode,
  BridgeHandle,
  BridgeTargetView,
} from '../shared/bridge-protocol';
import type {
  AgentMessage,
  ContentBlock,
  ReadonlySessionManager,
  SessionEntry,
  SessionMessageEntry,
} from './pi-extension-api';

export interface ResolvedTargets {
  ok: true;
  targets: BridgeTargetView[];
  /** Every entry the operation will touch, in branch order. */
  groupIds: string[];
}

export interface ResolveFailure {
  ok: false;
  code: BridgeErrorCode;
  error: string;
}

export type ResolveResult = ResolvedTargets | ResolveFailure;

/**
 * `group` — an omission may only take a whole assistant turn with it: the reply and every result of its
 * calls, because a `toolCall` may not survive without its result (pi's own final-attempt recovery omits
 * exactly that set, `_omitRecoveryAttempt`). For a tool-result target the group is the result alone —
 * see {@link expandOmitGroup}.
 *
 * `single` — just the addressed entry, which is what a content replacement needs: replacing one result
 * keeps the turn structurally valid.
 */
export type ResolveScope = 'group' | 'single';

function isMessage(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === 'message';
}

function messageOf(entry: SessionEntry): AgentMessage | undefined {
  return isMessage(entry) ? entry.message : undefined;
}

/** The tool-call ids one assistant message asked for, in the order the model emitted them. */
export function toolCallIdsOf(message: AgentMessage | undefined): string[] {
  if (
    !message ||
    message.role !== 'assistant' ||
    !Array.isArray(message.content)
  )
    return [];
  return (message.content as ContentBlock[])
    .filter(
      (block): block is ContentBlock & { id: string } =>
        block?.type === 'toolCall' && typeof block.id === 'string',
    )
    .map((block) => block.id);
}

/** The plain text of a message, for the identity matching a user-text handle needs. */
export function textOf(message: AgentMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .filter((block) => block?.type === 'text')
    .map((block) => (block as { text?: string }).text ?? '')
    .join('');
}

function viewOf(entry: SessionEntry): BridgeTargetView {
  const message = messageOf(entry);
  const view: BridgeTargetView = {
    entryId: entry.id,
    role:
      message?.role === 'user' ||
      message?.role === 'assistant' ||
      message?.role === 'toolResult'
        ? message.role
        : 'assistant',
  };
  if (
    message?.role === 'toolResult' &&
    typeof message.toolCallId === 'string'
  ) {
    view.toolCallId = message.toolCallId;
  }
  return view;
}

/** Message entries of the current branch, root → leaf. */
function branchMessages(sm: ReadonlySessionManager): SessionMessageEntry[] {
  return sm.getBranch().filter(isMessage);
}

/** The persisted result entry of one tool call, or undefined when this branch never ran it. */
export function entryIdOfToolCallId(
  toolCallId: string,
  sm: ReadonlySessionManager,
): string | undefined {
  const entries = branchMessages(sm);
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message;
    if (message?.role === 'toolResult' && message.toolCallId === toolCallId)
      return entries[i].id;
  }
  return undefined;
}

/**
 * The entries an omission takes with its target.
 *
 * An assistant entry (an entry-addressed omission) brings its results along: dropping the reply alone
 * would orphan every call it made. A single tool result stands alone, because the bridge gives that
 * call a placeholder answer instead of none — so the reply, its thinking and the sibling results all
 * stay where the user can still read them, and the transcript does not lose a message nobody deleted.
 */
export function expandOmitGroup(
  target: SessionEntry,
  branch: SessionEntry[],
): string[] {
  const index = branch.findIndex((entry) => entry.id === target.id);
  if (index < 0) return [target.id];
  const message = messageOf(target);
  if (!message) return [target.id];
  if (message.role === 'toolResult') return [target.id];
  if (message.role !== 'assistant') return [target.id];

  const assistant = target;
  const callIds = new Set(toolCallIdsOf(message));
  const ids: string[] = [assistant.id];
  for (let i = index + 1; i < branch.length; i++) {
    const sibling = messageOf(branch[i]);
    if (!sibling) continue;
    if (sibling.role === 'assistant') break;
    if (sibling.role === 'toolResult' && callIds.has(sibling.toolCallId ?? ''))
      ids.push(branch[i].id);
  }
  return ids;
}

/**
 * Whether an entry is already out of the model's context because the newest compaction summarised
 * past it. Editing such an entry is legal but pointless — the projection no longer contains it — so the
 * bridge refuses rather than reporting a success the user cannot observe.
 */
export function isPreCompaction(
  entryId: string,
  sm: ReadonlySessionManager,
): boolean {
  return !sm.buildContextEntries().some((entry) => entry.id === entryId);
}

export function resolveTargets(
  handle: BridgeHandle,
  sm: ReadonlySessionManager,
  scope: ResolveScope,
): ResolveResult {
  const branch = sm.getBranch();
  const fail = (code: BridgeErrorCode, error: string): ResolveFailure => ({
    ok: false,
    code,
    error,
  });

  let target: SessionEntry | undefined;
  if (handle.kind === 'toolCall') {
    const entryId = entryIdOfToolCallId(handle.toolCallId, sm);
    if (!entryId) {
      return fail(
        'unknown-handle',
        `no tool result for call ${handle.toolCallId} on this branch`,
      );
    }
    target = branch.find((entry) => entry.id === entryId);
  } else if (handle.kind === 'entry') {
    target = branch.find((entry) => entry.id === handle.entryId);
    if (!target)
      return fail(
        'no-such-entry',
        `entry ${handle.entryId} is not on this branch`,
      );
  } else {
    const matches = branch.filter((entry) => {
      const message = messageOf(entry);
      return message?.role === 'user' && textOf(message) === handle.text;
    });
    if (matches.length === 0)
      return fail(
        'unknown-handle',
        `no message matching ${JSON.stringify(handle.text)}`,
      );
    if (handle.occurrence === undefined) {
      if (matches.length > 1) {
        return fail(
          'ambiguous-handle',
          `${matches.length} messages read ${JSON.stringify(handle.text)}`,
        );
      }
      target = matches[0];
    } else if (handle.occurrence === 'newest') {
      target = matches[matches.length - 1];
    } else {
      const ordered = [...matches].sort(
        (a, b) => branch.indexOf(a) - branch.indexOf(b),
      );
      target = ordered[handle.occurrence];
      if (!target)
        return fail(
          'unknown-handle',
          `no ${handle.occurrence}th message matching ${JSON.stringify(handle.text)}`,
        );
    }
  }

  if (!target) return fail('unknown-handle', 'target entry is gone');
  if (isPreCompaction(target.id, sm)) {
    return fail(
      'pre-compaction',
      'this message is already summarised out of context',
    );
  }

  const groupIds =
    scope === 'group' ? expandOmitGroup(target, branch) : [target.id];
  const byId = new Map(branch.map((entry) => [entry.id, entry]));
  const targets = groupIds
    .map((id) => byId.get(id))
    .filter((entry): entry is SessionEntry => entry !== undefined)
    .map(viewOf);
  return { ok: true, targets, groupIds };
}
