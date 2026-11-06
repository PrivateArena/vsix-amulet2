import type { ContextEditView } from '../../shared/protocol';

/**
 * The context edits this host *applied* but pi has not written yet, remembered per session file.
 *
 * Two things make this more than a field of one bridge:
 *  - a `context_edit` is only written at a turn boundary, so between the click and the next run the
 *    session file says nothing about what the user just did — the badges would be missing exactly while
 *    the change is in effect;
 *  - N surfaces share one runtime, and only the surface that asked for the operation holds the reply.
 *    Keyed by session file rather than by bridge, every surface's push says the same thing (plan F-5).
 *
 * A view retires itself as soon as the durable list carries the same target, which is why no timer is
 * involved. Failures are one-shot on purpose: a refusal is news, not a fact about the conversation, and
 * a card that keeps claiming "could not edit" after the human has moved on is a lie of its own.
 */
export class AppliedEditStore {
  private readonly byFile = new Map<
    string,
    {
      views: Map<string, ContextEditView>;
      failures: Map<string, ContextEditView>;
    }
  >();

  constructor(private readonly capacity = 8) {}

  private entry(
    sessionFile: string | null,
  ):
    | {
        views: Map<string, ContextEditView>;
        failures: Map<string, ContextEditView>;
      }
    | undefined {
    return sessionFile ? this.byFile.get(sessionFile) : undefined;
  }

  private open(sessionFile: string): {
    views: Map<string, ContextEditView>;
    failures: Map<string, ContextEditView>;
  } {
    let found = this.byFile.get(sessionFile);
    if (!found) {
      found = { views: new Map(), failures: new Map() };
      this.byFile.set(sessionFile, found);
      while (this.byFile.size > this.capacity) {
        const oldest = this.byFile.keys().next();
        if (oldest.done) break;
        this.byFile.delete(oldest.value);
      }
    }
    return found;
  }

  /** An operation the runtime accepted (or refused) for one card. */
  remember(sessionFile: string | null, view: ContextEditView, ok = true): void {
    if (!sessionFile) return;
    const key = view.toolCallId ?? view.entryId;
    const entry = this.open(sessionFile);
    if (ok) entry.views.set(key, view);
    else entry.failures.set(key, view);
  }

  /** Drop what a card claims: used by `restore`, whose success means *no* badge, not a new one. */
  forget(sessionFile: string | null, ...keys: (string | undefined)[]): void {
    const entry = this.entry(sessionFile);
    if (!entry) return;
    for (const key of keys) {
      if (!key) continue;
      entry.views.delete(key);
      entry.failures.delete(key);
    }
  }

  /**
   * Durable records first, then the views nothing has confirmed yet, then the refusals — which are
   * consumed here, so they are posted once and never again.
   */
  merge(
    sessionFile: string | null,
    durable: ContextEditView[],
  ): ContextEditView[] {
    const entry = this.entry(sessionFile ?? '');
    if (!entry) return durable;
    const keys = new Set(
      durable.map((view) => view.toolCallId ?? view.entryId),
    );
    for (const key of keys) {
      // The file now states it, so the provisional claim is redundant — and a provisional `applying`
      // badge would outrank the truth about a target that has since moved on.
      entry.views.delete(key);
    }
    const out = [...durable, ...entry.views.values()];
    if (entry.failures.size) {
      out.push(...entry.failures.values());
      entry.failures.clear();
    }
    return out;
  }
}

/** One store per extension host: the edits belong to the runtime the surfaces share. */
export const appliedEdits = new AppliedEditStore();
