/**
 * The bridge's in-memory override map, plus the sidecar that keeps it alive across a restart.
 *
 * Two clocks, both necessary:
 *  - *Now*: the durable `context_edit` can only be appended at a turn boundary, so an idle omission
 *    would not take effect until the next `turn_end` — and the first provider request of the run that
 *    follows happens *before* any of its boundaries. The `context` hook applies this map to every
 *    request, so the model stops seeing the text the moment the user asked.
 *  - *Later*: {@link drafts} hands the same edits to `turn_end`, which writes them into the session as
 *    append-only `context_edit` entries — the only write path an extension has (see
 *    `pi-extension-api.ts`), and the reason Amulet never opens pi's session file for writing.
 *
 * Sidecar format (`v: 1`), written next to the session file as
 * `amulet-context-overrides--<session basename>.json` — never a `.jsonl`, so neither pi's nor Amulet's
 * session listing can mistake it for a session:
 *
 *     { "v": 1, "sessionFile": "/…/<session>.jsonl", "edits": [PendingEdit, …] }
 *
 * Written `.tmp` + rename, and read back only by the same session file it names.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { CONTEXT_OMIT_PLACEHOLDER } from '../shared/bridge-protocol';
import type {
  AgentMessage,
  ContentBlock,
  ContextEditEntryDraft,
  MessageContent,
  SessionEntry,
} from './pi-extension-api';

/** The current sidecar layout. A file of another version is ignored, not migrated. */
const SIDECAR_VERSION = 1;

/** What the model reads instead of an output it may no longer see. */
const OMITTED_RESULT_PLACEHOLDER = CONTEXT_OMIT_PLACEHOLDER;

/** How a pending edit finds its message in a list that carries no entry ids. */
export type PendingMatcher =
  /** The result of one tool call — unique per call id. */
  | { kind: 'toolResult'; toolCallId: string }
  /** The assistant message that issued one call. */
  | { kind: 'assistant'; toolCallId: string }
  /** Any other message, matched on its exact role and text. */
  | { kind: 'text'; role: string; text: string };

export interface PendingEdit {
  targetId: string;
  /** null = keep the entry out of context; a value = send this content in its place. */
  replacement: { content: MessageContent } | null;
  reqId: string;
  matcher: PendingMatcher;
  /** When the user asked for it; carried for the sidecar and the log. */
  at: string;
}

export interface PendingStoreOptions {
  /** Session file the map belongs to; without one the store is memory-only. */
  sessionFile?: string;
  log?: (message: string) => void;
}

function contentOf(message: AgentMessage): ContentBlock[] {
  const content = message.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function toolCallIds(message: AgentMessage): string[] {
  if (message.role !== 'assistant') return [];
  return contentOf(message)
    .filter(
      (block) =>
        block?.type === 'toolCall' &&
        typeof (block as { id?: unknown }).id === 'string',
    )
    .map((block) => (block as { id: string }).id);
}

function textOfContent(message: AgentMessage): string {
  return contentOf(message)
    .filter((block) => block?.type === 'text')
    .map((block) => (block as { text?: string }).text ?? '')
    .join('');
}

/** pi's own normalization: assistant and tool-result content is a block array, never a bare string. */
export function normalizeReplacementContent(
  content: MessageContent,
): MessageContent {
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
}

/**
 * What an omitted tool result says instead. A placeholder rather than a deletion: the call is still
 * answered, so the request stays valid, the reply around it stays in the model's context and in the
 * transcript, and the durable entry that later records the omission is recognisable by this exact text
 * (`session-store.ts` turns it back into an `omitted` badge).
 */
export function omittedReplacement(): { content: MessageContent } {
  return {
    content: [{ type: 'text', text: OMITTED_RESULT_PLACEHOLDER }],
  };
}

function sameContent(
  a: MessageContent | undefined,
  b: MessageContent | undefined,
): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/** `…/<session>.jsonl` → `amulet-context-overrides--<session basename>.json` beside it. */
export function sidecarPath(sessionFile: string): string {
  const base = basename(sessionFile).replace(/\.jsonl$/i, '');
  return join(dirname(sessionFile), `amulet-context-overrides--${base}.json`);
}

export class PendingStore {
  private readonly edits = new Map<string, PendingEdit>();
  private readonly sessionFile: string | undefined;
  private readonly log: (message: string) => void;

  constructor(options: PendingStoreOptions = {}) {
    this.sessionFile = options.sessionFile;
    this.log = options.log ?? (() => undefined);
  }

  /** The file this map is persisted to, or undefined when the session has none yet. */
  filePath(): string | undefined {
    return this.sessionFile ? sidecarPath(this.sessionFile) : undefined;
  }

  /** The session these overrides belong to (undefined for an unpersisted session). */
  file(): string | undefined {
    return this.sessionFile;
  }

  /**
   * Take over edits another store was holding — the session file moved (or was only just created)
   * while the user's omissions were still in memory. No flush: the caller writes them itself.
   */
  restore(edits: PendingEdit[]): void {
    for (const edit of edits) {
      if (!this.edits.has(edit.targetId)) this.edits.set(edit.targetId, edit);
    }
  }

  /**
   * Read the sidecar back after a start or a restart.
   *
   * A file that cannot be read, parses to something else, or names another session is dropped rather
   * than fatal: an override the user did not ask for is worse than one that was forgotten, and pi
   * still has to boot.
   */
  async load(): Promise<void> {
    this.edits.clear();
    const path = this.filePath();
    if (!path || !this.sessionFile) return;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        v?: number;
        sessionFile?: string;
        edits?: PendingEdit[];
      };
      if (
        parsed.v !== SIDECAR_VERSION ||
        parsed.sessionFile !== this.sessionFile
      ) {
        this.log(`ignoring stale context override file ${path}`);
        return;
      }
      for (const edit of parsed.edits ?? []) {
        if (typeof edit?.targetId !== 'string' || !edit.matcher) continue;
        this.edits.set(edit.targetId, edit);
      }
      if (this.edits.size)
        this.log(`restored ${this.edits.size} pending context edit(s)`);
    } catch (err) {
      this.log(
        `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  list(): PendingEdit[] {
    return [...this.edits.values()];
  }

  get(targetId: string): PendingEdit | undefined {
    return this.edits.get(targetId);
  }

  size(): number {
    return this.edits.size;
  }

  async set(edit: PendingEdit): Promise<void> {
    this.edits.set(edit.targetId, edit);
    await this.flush();
  }

  async delete(targetId: string): Promise<void> {
    if (!this.edits.delete(targetId)) return;
    await this.flush();
  }

  /** Drop everything (a session switch — the sidecar belongs to the file that was left). */
  clear(): void {
    this.edits.clear();
  }

  /** The durable writes to propose at the next `turn_end`, oldest request first. */
  drafts(): ContextEditEntryDraft[] {
    return this.list().map((edit) => ({
      type: 'context_edit',
      targetId: edit.targetId,
      replacement: edit.replacement,
    }));
  }

  /**
   * Forget the edits this session no longer answers for.
   *
   * Two ways an edit stops being ours, and both must be checked here because a stale draft is not
   * merely useless — `appendContextEdit` **throws** for a target that left the active branch, and pi
   * discards the whole boundary proposal when a draft fails, taking every other extension's draft with
   * it. So:
   *  - *already durable*: compared by content, not by time, because the entry we are looking for is the
   *    one that says exactly what the pending edit says;
   *  - *off the branch*: a revert, a `/tree` navigation or a fork abandoned the very messages the edit
   *    was aimed at, and no future turn can persist it.
   *
   * `contextEntries` is `buildContextEntries()` (compaction-aware, edits included); `branch` is
   * `getBranch()` — membership, which is what pi's own check uses.
   */
  prune(contextEntries: SessionEntry[], branch: SessionEntry[]): void {
    if (!this.edits.size) return;
    const onBranch = new Set(branch.map((entry) => entry.id));
    const durable = new Map<string, { content: MessageContent } | null>();
    for (const entry of contextEntries) {
      if (entry.type !== 'context_edit') continue;
      const edit = entry as {
        targetId?: string;
        replacement?: { content: MessageContent } | null;
      };
      if (typeof edit.targetId === 'string')
        durable.set(edit.targetId, edit.replacement ?? null);
    }
    let changed = false;
    for (const [targetId, pending] of this.edits) {
      if (!onBranch.has(targetId)) {
        this.edits.delete(targetId);
        changed = true;
        continue;
      }
      const persisted = durable.get(targetId);
      if (persisted === undefined) continue;
      const same =
        (persisted === null) === (pending.replacement === null) &&
        (persisted === null ||
          sameContent(persisted.content, pending.replacement?.content));
      if (same) {
        this.edits.delete(targetId);
        changed = true;
      }
    }
    if (changed) void this.flush();
  }

  /**
   * Apply the map to the messages pi is about to send.
   *
   * Copy-on-change, and the output always satisfies the provider invariant: no assistant `toolCall`
   * survives without its result, which is why a lone result omission that somehow lost its group turns
   * into a placeholder instead of a 400.
   */
  applyTo(messages: AgentMessage[]): AgentMessage[] {
    if (!this.edits.size) return messages;
    const drop = new Set<number>();
    const replace = new Map<number, MessageContent>();
    for (const edit of this.edits.values()) {
      const index = findMatch(messages, edit.matcher);
      if (index < 0 || messages[index].role === 'system') continue;
      if (edit.replacement === null) drop.add(index);
      else
        replace.set(
          index,
          normalizeReplacementContent(edit.replacement.content),
        );
    }
    if (!drop.size && !replace.size) return messages;

    const out: AgentMessage[] = [];
    // The calls this edit map is responsible for losing — a dropped result, or a dropped reply that
    // asked for one. Only these may ever get a placeholder back: an already-missing result was pi's
    // business, not ours, and inventing one would put words in the model's mouth.
    const lostCallIds = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!drop.has(i)) continue;
      if (
        message.role === 'toolResult' &&
        typeof message.toolCallId === 'string'
      ) {
        lostCallIds.add(message.toolCallId);
      }
      for (const id of toolCallIds(message)) lostCallIds.add(id);
    }
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (drop.has(i)) continue;
      const content = replace.get(i);
      out.push(content === undefined ? message : { ...message, content });
    }
    return closeOrphanedToolCalls(out, lostCallIds);
  }

  private async flush(): Promise<void> {
    const path = this.filePath();
    if (!path || !this.sessionFile) return;
    const payload = {
      v: SIDECAR_VERSION,
      sessionFile: this.sessionFile,
      edits: this.list(),
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
      await rename(tmp, path);
    } catch (err) {
      // Losing the override is survivable; losing the child is not, so this never throws upward.
      this.log(
        `could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Newest message the matcher describes, or -1. Newest wins because an edited transcript re-sends old text. */
function findMatch(messages: AgentMessage[], matcher: PendingMatcher): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message.role !== 'string') continue;
    if (matcher.kind === 'toolResult') {
      if (
        message.role === 'toolResult' &&
        message.toolCallId === matcher.toolCallId
      )
        return i;
    } else if (matcher.kind === 'assistant') {
      if (
        message.role === 'assistant' &&
        toolCallIds(message).includes(matcher.toolCallId)
      )
        return i;
    } else if (
      message.role === matcher.role &&
      textOfContent(message) === matcher.text
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Give every call this store took the result of back.
 *
 * The group rules in `target-resolver.ts` should make this unreachable; it is here because the
 * alternative is a provider error that takes the whole run down (plan F-3). A call whose result went
 * away gets one placeholder, right after the reply that asked for it.
 */
function closeOrphanedToolCalls(
  messages: AgentMessage[],
  lostCallIds: Set<string>,
): AgentMessage[] {
  if (!lostCallIds.size) return messages;
  const present = new Set<string>();
  for (const message of messages) {
    if (
      message.role === 'toolResult' &&
      typeof message.toolCallId === 'string'
    ) {
      present.add(message.toolCallId);
    }
  }
  const out: AgentMessage[] = [];
  let fixed = false;
  for (const message of messages) {
    out.push(message);
    if (message.role !== 'assistant') continue;
    const orphans = toolCallIds(message).filter(
      (id) => lostCallIds.has(id) && !present.has(id),
    );
    if (!orphans.length) continue;
    // The placeholder lands right after the reply that asked for it, ahead of any result it did keep:
    // a provider only requires the results to follow their call, not to keep any particular order.
    for (const id of orphans) {
      out.push({
        role: 'toolResult',
        toolCallId: id,
        toolName: 'unknown',
        content: [{ type: 'text', text: OMITTED_RESULT_PLACEHOLDER }],
        isError: true,
        timestamp: Date.now(),
      });
      present.add(id);
      fixed = true;
    }
  }
  return fixed ? out : messages;
}

/** The matcher that recognises one session entry in a later request's message list. */
export function matcherOf(entry: SessionEntry): PendingMatcher | undefined {
  if (entry.type !== 'message') return undefined;
  const message = (entry as { message?: AgentMessage }).message;
  if (!message || message.role === 'system') return undefined;
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return { kind: 'toolResult', toolCallId: message.toolCallId };
  }
  if (message.role === 'assistant') {
    const ids = toolCallIds(message);
    if (ids.length) return { kind: 'assistant', toolCallId: ids[0] };
  }
  return { kind: 'text', role: message.role, text: textOfContent(message) };
}
