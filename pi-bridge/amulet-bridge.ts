/**
 * The Amulet bridge: the pi extension that gives the extension host the three things its RPC client
 * cannot do — hold a tool result or a reply out of the model's context, replace the text of one, and
 * move the conversation back to an earlier message.
 *
 * It is loaded with `pi -e <bundle>` (see `src/runtime/bridge-args.ts`) and speaks exactly one
 * protocol, `shared/bridge-protocol.ts`:
 *
 *   host  →  `prompt("/amulet {json}")`                (an extension command: pi runs it, writes nothing)
 *   host  ←  `ctx.ui.notify("amulet:reply {json}")`     (correlated by `reqId`, intercepted before the toast)
 *
 * Rules this file owns, and why:
 *  - **No tool, no prompt section, no system-prompt edit.** Anything registered there is part of the
 *    cached prefix of every request; the bridge must cost nothing when it is doing nothing.
 *  - **`context` for now, `turn_end` for later.** The durable `context_edit` may only be written at a
 *    turn boundary, so the immediate effect comes from {@link PendingStore.applyTo} and the persistence
 *    from {@link PendingStore.drafts}. Without the hook, an omission made while idle would not apply to
 *    the first provider request of the next run — which is the exact text the user clicked against.
 *  - **Never a writer of pi's session file.** Drafts only; pi appends, so the branch leaf is never
 *    raced (see the plan's F-9).
 *  - **Never throws at the user.** Every path answers a parseable reply (or, worst case, logs), so the
 *    host's watchdog reports a reason instead of a hang.
 */

import {
  BRIDGE_COMMAND_NAME,
  BRIDGE_PROTOCOL_VERSION,
  encodeBridgeReply,
  isBridgeRequest,
  parseBridgeRequestArgs,
  type BridgeCapabilities,
  type BridgeErrorCode,
  type BridgeOp,
  type BridgeReply,
  type BridgeRequest,
  type BridgeTargetView,
} from '../shared/bridge-protocol';
import {
  PendingStore,
  matcherOf,
  normalizeReplacementContent,
  omittedReplacement,
  type PendingEdit,
} from './pending-store';
import { resolveTargets } from './target-resolver';
import type {
  AgentMessage,
  ContextEditEntryDraft,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageContent,
  ReadonlySessionManager,
  SessionEntry,
} from './pi-extension-api';

/** What the command shows as in the user's slash menu. It is never meant to be typed by hand. */
const BRIDGE_COMMAND_DESCRIPTION =
  'Amulet context surgery (used by the Amulet sidebar)';

function log(message: string): void {
  // stderr reaches Amulet's output channel through the child's stderr plumbing; `ctx.ui.notify` would
  // put a toast in front of the user for something only the host can act on.
  console.error(`[amulet-bridge] ${message}`);
}

function sameFile(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * The one live {@link PendingStore}, re-made when the session file moves (new, resume, fork, switch)
 * and re-read from its sidecar, which is what survives a runtime restart.
 */
export class BridgeSessions {
  private store: PendingStore | undefined;
  /** One step at a time: a start and a command must not read the sidecar over each other's write. */
  private queue: Promise<unknown> = Promise.resolve();

  get current(): PendingStore | undefined {
    return this.store;
  }

  sync(
    ctx: ExtensionContext,
    force = false,
    // Whether the edits this store holds belong to the session it is moving to. Only a fork, or a
    // session file that has just appeared for the first time, may say so — see `doSync`.
    carry = false,
  ): Promise<PendingStore | undefined> {
    const run = this.queue.then(
      () => this.doSync(ctx, force, carry),
      () => this.doSync(ctx, force, carry),
    );
    // A failure is already reported inside `doSync`; keep the chain alive regardless.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doSync(
    ctx: ExtensionContext,
    force: boolean,
    carry: boolean,
  ): Promise<PendingStore | undefined> {
    const file = ctx.sessionManager.getSessionFile();
    if (this.store && !force && sameFile(this.store.file(), file))
      return this.store;
    const previous = this.store?.list() ?? [];
    const next = new PendingStore({ sessionFile: file });
    this.store = next;
    try {
      await next.load();
      // Only a move that kept the conversation may keep the in-memory edits. A fork reuses the entry
      // ids and stays the same discussion; `new` and `resume` land on a different session whose entries
      // the user never edited — and a text matcher would happily hide a message that merely reads the
      // same. A store that never had a file to persist to is the same session, one line older.
      if (carry) next.restore(previous);
    } catch (err) {
      log(
        `session sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return next;
  }
}

export default function amuletBridge(pi: ExtensionAPI): void {
  const sessions = new BridgeSessions();

  pi.on('session_start', async (event, ctx) => {
    // `fork` keeps the entries (ids included), `new`/`resume` do not; `startup`/`reload` re-read the
    // sidecar of the file they are on, which is the whole point of writing one.
    await sessions.sync(ctx, true, event.reason === 'fork');
  });

  pi.on('session_tree', async (_event, ctx) => {
    // The leaf moved (a revert, a `/tree` navigation, a fork): edits of the abandoned branch are no
    // longer ours to carry, and ones the new branch already records are durable.
    const active = await sessions.sync(ctx, false, false);
    if (!active) return;
    active.prune(
      ctx.sessionManager.buildContextEntries(),
      ctx.sessionManager.getBranch(),
    );
  });

  pi.on('context', (event, ctx) => {
    const active = sessions.current;
    if (!active || !active.size()) return undefined;
    try {
      return { messages: active.applyTo(event.messages) };
    } catch (err) {
      // A broken override must never cost the user their run.
      log(
        `context hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      void ctx;
      return undefined;
    }
  });

  pi.on('turn_end', (event, ctx) => {
    const active = sessions.current;
    if (!active || !active.size()) return undefined;
    try {
      active.prune(
        ctx.sessionManager.buildContextEntries(),
        ctx.sessionManager.getBranch(),
      );
      const drafts: ContextEditEntryDraft[] = active.drafts();
      if (!drafts.length) return undefined;
      return { entries: [...(event.entries ?? []), ...drafts] };
    } catch (err) {
      log(
        `turn_end draft failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  });

  pi.registerCommand(BRIDGE_COMMAND_NAME, {
    description: BRIDGE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const parsed = parseBridgeRequestArgs(args);
      if (!isBridgeRequest(parsed)) {
        log(`rejected payload: ${parsed.error}`);
        // No reqId to answer to: this text is noise to the host's reply parser and a diagnostic for a
        // human who typed `/amulet` by hand.
        ctx.ui.notify(`amulet bridge: ${parsed.error}`, 'warning');
        return;
      }
      let reply: BridgeReply;
      try {
        reply = await runOp(parsed, ctx, sessions);
      } catch (err) {
        reply = failure(
          parsed.reqId,
          parsed.op,
          'busy',
          err instanceof Error ? err.message : String(err),
        );
      }
      ctx.ui.notify(encodeBridgeReply(reply));
    },
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function okReply(
  req: BridgeRequest,
  extra: {
    targets?: BridgeTargetView[];
    revertedFrom?: string;
    abandonedCount?: number;
    capabilities?: BridgeCapabilities;
  } = {},
): BridgeReply {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    reqId: req.reqId,
    op: req.op,
    ok: true,
    ...extra,
  };
}

function failure(
  reqId: string,
  op: BridgeOp,
  code: BridgeErrorCode,
  error: string,
): BridgeReply {
  return { v: BRIDGE_PROTOCOL_VERSION, reqId, op, ok: false, error, code };
}

/** The entry an edit addresses, on the live branch. */
function entryOnBranch(
  sm: ReadonlySessionManager,
  id: string,
): SessionEntry | undefined {
  return sm.getBranch().find((entry) => entry.id === id);
}

/** The untouched content of an entry — what a restore puts back, since an edit never rewrites its target. */
function contentOf(
  entry: SessionEntry,
): { content: MessageContent } | undefined {
  const message = (entry as { message?: AgentMessage }).message;
  if (!message || typeof message.content === 'undefined') return undefined;
  return { content: message.content };
}

/** The role an entry contributes, or empty for an entry that contributes no message. */
function messageRole(entry: SessionEntry): string {
  return (entry as { message?: AgentMessage }).message?.role ?? '';
}

async function runOp(
  req: BridgeRequest,
  ctx: ExtensionCommandContext,
  sessions: BridgeSessions,
): Promise<BridgeReply> {
  if (req.op === 'hello') {
    return okReply(req, {
      capabilities: {
        contextEdit: true,
        navigateTree: typeof ctx.navigateTree === 'function',
        // pi's own version is the host's fact (`pi --version`), not one the child has to re-derive.
        piVersion: '',
      },
    });
  }

  // Every other op moves persistent state, so all of them are idle-only: `navigateTree` rejects during
  // a run, and a turn boundary is the only place a `context_edit` may be written.
  if (!ctx.isIdle()) {
    return failure(
      req.reqId,
      req.op,
      'not-idle',
      'pi is working; wait for the run to finish',
    );
  }

  if (req.op === 'revert' || req.op === 'undo-revert')
    return runRevert(req, ctx, sessions);

  const sm = ctx.sessionManager;
  const active = await sessions.sync(ctx);
  if (!active)
    return failure(req.reqId, req.op, 'busy', 'no session to edit yet');
  if (!req.handle)
    return failure(req.reqId, req.op, 'unknown-handle', 'missing handle');

  const scope = req.op === 'replace' ? 'single' : 'group';
  const resolved = resolveTargets(req.handle, sm, scope);
  if (!resolved.ok)
    return failure(req.reqId, req.op, resolved.code, resolved.error);

  const at = new Date().toISOString();
  const edits: PendingEdit[] = [];
  for (const id of resolved.groupIds) {
    const entry = entryOnBranch(sm, id);
    const matcher = entry ? matcherOf(entry) : undefined;
    if (!matcher || !entry) continue;
    let replacement: { content: MessageContent } | null;
    if (req.op === 'replace') {
      replacement = { content: normalizeReplacementContent(req.content ?? '') };
    } else if (req.op === 'restore') {
      // "Restore" means "put the untouched entry back", and the untouched entry is still there: an
      // edit replaces a projection, never the persisted message.
      const original = contentOf(entry);
      if (!original) continue;
      replacement = original;
    } else {
      // An omitted *result* is answered by a placeholder rather than deleted, so the reply that asked for
      // it stays in the request — and in the transcript after a reload. An omitted *reply* (or user turn)
      // has nothing to answer, so the resolved group goes with it: `expandOmitGroup` only pairs an
      // assistant entry with its own results, which keeps the request structurally valid.
      replacement =
        messageRole(entry) === 'toolResult' ? omittedReplacement() : null;
    }
    edits.push({ targetId: id, replacement, reqId: req.reqId, matcher, at });
  }
  if (!edits.length) {
    return failure(
      req.reqId,
      req.op,
      'unknown-handle',
      'no editable message on this branch',
    );
  }
  for (const edit of edits) await active.set(edit);
  return okReply(req, { targets: resolved.targets });
}

/**
 * Move the leaf. `summarize: false` always — a branch summary is an LLM call that *appends* content,
 * which is exactly what makes a rewind cheap.
 */
async function runRevert(
  req: BridgeRequest,
  ctx: ExtensionCommandContext,
  sessions: BridgeSessions,
): Promise<BridgeReply> {
  if (typeof ctx.navigateTree !== 'function') {
    return failure(
      req.reqId,
      req.op,
      'unsupported',
      'this pi build cannot navigate the session tree',
    );
  }
  const entryId = req.entryId;
  if (!entryId)
    return failure(req.reqId, req.op, 'no-such-entry', 'missing entryId');
  const sm = ctx.sessionManager;
  // Validated against the whole tree, not the current branch: the point an earlier revert abandoned is
  // no longer on this branch, and undoing one has to be able to name it.
  if (!sm.getEntry(entryId)) {
    return failure(
      req.reqId,
      req.op,
      'no-such-entry',
      `entry ${entryId} is not in this session`,
    );
  }
  const branch = sm.getBranch();
  const index = branch.findIndex((entry) => entry.id === entryId);
  const from = sm.getLeafId() ?? '';
  let result: { cancelled: boolean };
  try {
    result = await ctx.navigateTree(entryId, { summarize: false });
  } catch (err) {
    // pi rejects while a response, a compaction or another navigation is active — and leaves the
    // branch alone. That is the answer the UI needs, verbatim.
    return failure(
      req.reqId,
      req.op,
      'busy',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (result.cancelled) {
    return failure(
      req.reqId,
      req.op,
      'cancelled',
      'an extension cancelled the navigation',
    );
  }
  const active = await sessions.sync(ctx, false, false);
  active?.prune(sm.buildContextEntries(), sm.getBranch());
  return okReply(req, {
    revertedFrom: from,
    // What this move discarded from the live branch (0 when navigating forward to a sibling).
    abandonedCount: index < 0 ? 0 : Math.max(0, branch.length - 1 - index),
  });
}
