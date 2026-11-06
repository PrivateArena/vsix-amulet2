import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PendingStore,
  matcherOf,
  sidecarPath,
  type PendingEdit,
  type PendingMatcher,
} from './pending-store';
import type {
  AgentMessage,
  ContextEditEntry,
  MessageContent,
  SessionEntry,
  SessionMessageEntry,
} from './pi-extension-api';

/**
 * The bridge's live override map — the half that makes an omission true for the *next* request rather
 * than after the next turn boundary — and the sidecar that keeps it alive across a restart.
 *
 * Two invariants drive every case here:
 *  - the provider must never see a `toolCall` without its result, so a lone result omission degrades to
 *    a placeholder instead of a 400, while a genuine group omission leaves nothing to close;
 *  - the map is applied copy-on-change, because the array pi hands the `context` hook is its own.
 */

const T = '2026-11-06T09:00:00.000Z';

function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
): SessionMessageEntry {
  return { type: 'message', id, parentId, timestamp: T, message };
}

interface Fixture {
  user: SessionMessageEntry;
  assistant: SessionMessageEntry;
  read: SessionMessageEntry;
  bash: SessionMessageEntry;
  entries: SessionMessageEntry[];
  messages: AgentMessage[];
}

/** `user → assistant(read, bash) → result(read) → result(bash)` — the shape an omitted result lives in. */
function fixture(): Fixture {
  const user = messageEntry('u1', null, {
    role: 'user',
    content: [{ type: 'text', text: 'run the suite' }],
  });
  const assistant = messageEntry('a1', 'u1', {
    role: 'assistant',
    content: [
      { type: 'text', text: 'reading, then running' },
      { type: 'toolCall', id: 'call_read', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'call_bash', name: 'bash', arguments: {} },
    ],
  });
  const read = messageEntry('tr_read', 'a1', {
    role: 'toolResult',
    toolCallId: 'call_read',
    toolName: 'read',
    content: [{ type: 'text', text: '…the whole file…' }],
  });
  const bash = messageEntry('tr_bash', 'a1', {
    role: 'toolResult',
    toolCallId: 'call_bash',
    toolName: 'bash',
    content: [{ type: 'text', text: '42 passed' }],
  });
  const entries = [user, assistant, read, bash];
  return {
    user,
    assistant,
    read,
    bash,
    entries,
    messages: entries.map((e) => e.message),
  };
}

/** The matcher an entry is found by in a later request — the same helper the bridge itself uses. */
function matcherOfEntry(entry: SessionEntry): PendingMatcher {
  const matcher = matcherOf(entry);
  if (!matcher) throw new Error(`no matcher for entry ${entry.id}`);
  return matcher;
}

function editOf(
  entry: SessionEntry,
  replacement: { content: MessageContent } | null,
  reqId = 'req-1',
): PendingEdit {
  return {
    targetId: entry.id,
    replacement,
    reqId,
    matcher: matcherOfEntry(entry),
    at: T,
  };
}

function contextEdit(
  id: string,
  targetId: string,
  replacement: { content: MessageContent } | null,
): ContextEditEntry {
  return {
    type: 'context_edit',
    id,
    parentId: null,
    timestamp: T,
    targetId,
    replacement,
  };
}

function textOf(message: AgentMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => (block as { text?: string }).text ?? '')
    .join(' ');
}

const dirs: string[] = [];

/** A session file in a fresh temp dir, as pi would have it: an existing folder, a `.jsonl` name. */
function sessionFileIn(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'amulet-pending-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  dirs.push(dir);
  return join(dir, 'sessions', name);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('PendingStore.applyTo', () => {
  it('removes the addressed tool result and closes the orphan it would leave', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));

    const out = store.applyTo(f.messages);
    const results = out.filter((m) => m.role === 'toolResult');

    // The real output is gone, and the surviving one is untouched.
    expect(out).not.toContain(f.read.message);
    expect(out).toContain(f.bash.message);

    // …but the reply still has an answer for `call_read`: an orphan `toolCall` is a provider error.
    expect(results).toHaveLength(2);
    const placeholder = results.find((m) => m.toolCallId === 'call_read');
    expect(placeholder).toBeDefined();
    expect(placeholder).not.toBe(f.read.message);
    expect(textOf(placeholder)).toContain('Omitted from context');
    expect(placeholder?.isError).toBe(true);

    // The assistant message itself survives intact, both calls included.
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant).toBe(f.assistant.message);
    expect(assistant?.content).toEqual(f.assistant.message.content);
    // The answer follows the reply that asked for it, ahead of the result that stayed.
    expect(out.indexOf(placeholder!)).toBe(out.indexOf(assistant!) + 1);
    expect(out.indexOf(f.bash.message)).toBeGreaterThan(
      out.indexOf(placeholder!),
    );
  });

  it('drops a whole group with no placeholder when the reply goes with it', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.assistant, null));
    await store.set(editOf(f.read, null));
    await store.set(editOf(f.bash, null));

    const out = store.applyTo(f.messages);

    expect(out.map((m) => m.role)).toEqual(['user']);
    expect(out).toEqual([f.user.message]);
    expect(out.some((m) => m.role === 'toolResult')).toBe(false);
  });

  it('replaces only the addressed content and copies the array', async () => {
    const f = fixture();
    const original = f.messages;
    const snapshot = original.map((m) => ({ ...m }));
    const store = new PendingStore();
    await store.set(editOf(f.bash, { content: '2 failed, 40 passed' }));

    const out = store.applyTo(original);

    expect(out).not.toBe(original);
    // Copy-on-change: the messages nobody edited are the very same objects, and the input is untouched.
    expect(original).toEqual(snapshot);
    expect(out).toHaveLength(original.length);
    expect(out[0]).toBe(original[0]);
    expect(out[1]).toBe(original[1]);
    expect(out[2]).toBe(original[2]);
    expect(out[3]).not.toBe(original[3]);
    expect(out[3].role).toBe('toolResult');
    expect(out[3].toolCallId).toBe('call_bash');
    // A bare string becomes a block array — pi's own normalization for these roles.
    expect(out[3].content).toEqual([
      { type: 'text', text: '2 failed, 40 passed' },
    ]);
  });

  it('keeps a pending edit that matches no message in this request', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set({
      targetId: 'tr_other',
      replacement: null,
      reqId: 'req-1',
      matcher: { kind: 'toolResult', toolCallId: 'call_other' },
      at: T,
    });

    expect(store.applyTo(f.messages)).toBe(f.messages);
  });

  it('applies nothing before an edit exists', async () => {
    const f = fixture();
    const store = new PendingStore();
    expect(store.size()).toBe(0);
    expect(store.applyTo(f.messages)).toBe(f.messages);
  });
});

describe('PendingStore.drafts', () => {
  it('proposes one context_edit per pending edit', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));
    await store.set(editOf(f.bash, { content: 'trimmed' }));

    expect(store.drafts()).toEqual([
      { type: 'context_edit', targetId: 'tr_read', replacement: null },
      {
        type: 'context_edit',
        targetId: 'tr_bash',
        replacement: { content: 'trimmed' },
      },
    ]);
  });

  it('proposes nothing while the map is empty', () => {
    expect(new PendingStore().drafts()).toEqual([]);
  });
});

describe('PendingStore.prune', () => {
  it('forgets an edit the session already records, and keeps one it contradicts', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));
    await store.set(
      editOf(f.bash, { content: [{ type: 'text', text: 'trimmed' }] }),
    );

    store.prune([contextEdit('ce1', 'tr_read', null)], f.entries);
    expect(store.get('tr_read')).toBeUndefined();
    // A durable edit that says something else is not *this* edit — it is a newer one to overwrite.
    expect(store.get('tr_bash')).toBeDefined();

    store.prune(
      [contextEdit('ce2', 'tr_bash', { content: 'other text' })],
      f.entries,
    );
    expect(store.get('tr_bash')).toBeDefined();

    // The persisted spelling is what `appendContextEdit` wrote: it normalises a bare string into a block
    // array, exactly as `normalizeReplacementContent` does on the way in. Compared as text only, an
    // `Edit context content` would never retire and would be drafted again at every single turn.
    store.prune(
      [
        contextEdit('ce3', 'tr_bash', {
          content: [{ type: 'text', text: 'trimmed' }],
        }),
      ],
      f.entries,
    );
    expect(store.size()).toBe(0);
    expect(store.drafts()).toEqual([]);
  });

  it('keeps an edit with no durable counterpart at all', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));

    store.prune(f.entries, f.entries);
    expect(store.size()).toBe(1);
  });

  it('forgets an edit whose target has left the branch', async () => {
    // The reason this arm exists: `appendContextEdit` *throws* for an off-branch target, and pi discards
    // the whole boundary proposal when a draft fails — so a stale edit would silently void every later
    // turn's drafts, Amulet's and other extensions', forever.
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));
    const reverted = f.entries.filter((entry) => entry.id !== 'tr_read');

    store.prune([], reverted);
    expect(store.size()).toBe(0);
    expect(store.drafts()).toEqual([]);
  });
});

describe('PendingStore sidecar', () => {
  it('writes a non-jsonl file that the same session file reads back', async () => {
    const f = fixture();
    const sessionFile = sessionFileIn('session-a.jsonl');
    const store = new PendingStore({ sessionFile });
    await store.set(editOf(f.read, null));

    const path = sidecarPath(sessionFile);
    expect(store.filePath()).toBe(path);
    expect(store.file()).toBe(sessionFile);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).toBe(dirname(sessionFile));
    // Never a `.jsonl`: a session listing must not pick this up as a session.
    expect(basename(path)).toBe('amulet-context-overrides--session-a.json');
    expect(path.endsWith('.jsonl')).toBe(false);

    const payload = JSON.parse(readFileSync(path, 'utf8')) as {
      v: number;
      sessionFile: string;
      edits: PendingEdit[];
    };
    expect(payload.v).toBe(1);
    expect(payload.sessionFile).toBe(sessionFile);
    expect(payload.edits).toHaveLength(1);
    expect(payload.edits[0]).toMatchObject({
      targetId: 'tr_read',
      replacement: null,
    });

    const reloaded = new PendingStore({ sessionFile });
    await reloaded.load();
    expect(reloaded.size()).toBe(1);
    expect(reloaded.get('tr_read')).toMatchObject({
      targetId: 'tr_read',
      replacement: null,
      matcher: { kind: 'toolResult', toolCallId: 'call_read' },
    });
    // The point of the file: after the restart the override still bites.
    expect(reloaded.applyTo(f.messages)).not.toBe(f.messages);

    // …and a delete is persisted the same way, so a restore cannot resurrect it.
    await reloaded.delete('tr_read');
    const after = new PendingStore({ sessionFile });
    await after.load();
    expect(after.size()).toBe(0);
  });

  it('loads nothing for a different session file', async () => {
    const f = fixture();
    const sessionFile = sessionFileIn('session-a.jsonl');
    const store = new PendingStore({ sessionFile });
    await store.set(editOf(f.read, null));

    const other = new PendingStore({
      sessionFile: join(dirname(sessionFile), 'session-b.jsonl'),
    });
    await other.load();
    expect(other.size()).toBe(0);
    expect(other.applyTo(f.messages)).toBe(f.messages);
  });

  it('ignores a sidecar that names another session', async () => {
    const sessionFile = sessionFileIn('session-a.jsonl');
    const log = vi.fn();
    const store = new PendingStore({ sessionFile, log });
    await store.set(editOf(fixture().read, null));

    // Rewrite the file to claim a different session — a copy from a moved or forked session.
    const path = sidecarPath(sessionFile);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      path,
      JSON.stringify({ ...payload, sessionFile: '/elsewhere/session-x.jsonl' }),
      'utf8',
    );

    const reloaded = new PendingStore({ sessionFile, log });
    await reloaded.load();
    expect(reloaded.size()).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('stale');
  });

  it('survives an unreadable or garbage sidecar without throwing', async () => {
    const sessionFile = sessionFileIn('session-a.jsonl');
    const path = sidecarPath(sessionFile);

    // Nothing written yet.
    const missing = new PendingStore({ sessionFile });
    await missing.load();
    expect(missing.size()).toBe(0);

    writeFileSync(path, '{ not json', 'utf8');
    const log = vi.fn();
    const garbage = new PendingStore({ sessionFile, log });
    await expect(garbage.load()).resolves.toBeUndefined();
    expect(garbage.size()).toBe(0);
    expect(log).toHaveBeenCalled();

    writeFileSync(path, '[1,2,3]', 'utf8');
    const wrongShape = new PendingStore({ sessionFile });
    await wrongShape.load();
    expect(wrongShape.size()).toBe(0);

    // A directory where the file belongs is unreadable in a different way again.
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true });
    const unreadable = new PendingStore({ sessionFile });
    await expect(unreadable.load()).resolves.toBeUndefined();
    expect(unreadable.size()).toBe(0);
  });

  it('stays in memory when the session has no file yet', async () => {
    const f = fixture();
    const store = new PendingStore();
    expect(store.filePath()).toBeUndefined();
    await store.set(editOf(f.read, null));

    // No session file means nothing to persist to — and nothing to fail on, either.
    expect(store.size()).toBe(1);
    expect(store.applyTo(f.messages)).not.toBe(f.messages);
    await expect(store.load()).resolves.toBeUndefined();
    await expect(store.delete('tr_read')).resolves.toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe('PendingStore.restore', () => {
  it('takes over edits from the store that held them, without duplicates', async () => {
    const f = fixture();
    const store = new PendingStore();
    await store.set(editOf(f.read, null));

    const moved = new PendingStore();
    moved.restore(store.list());
    moved.restore(store.list());
    expect(moved.size()).toBe(1);
    expect(moved.drafts()).toEqual([
      { type: 'context_edit', targetId: 'tr_read', replacement: null },
    ]);
  });
});

describe('matcherOf', () => {
  it('addresses a result by its call, the reply by its first call, and text by text', () => {
    const f = fixture();
    expect(matcherOfEntry(f.read)).toEqual({
      kind: 'toolResult',
      toolCallId: 'call_read',
    });
    expect(matcherOfEntry(f.assistant)).toEqual({
      kind: 'assistant',
      toolCallId: 'call_read',
    });
    expect(matcherOfEntry(f.user)).toEqual({
      kind: 'text',
      role: 'user',
      text: 'run the suite',
    });
  });

  it('has no matcher for a non-message entry', () => {
    expect(matcherOf(contextEdit('ce1', 'tr_read', null))).toBeUndefined();
  });
});
