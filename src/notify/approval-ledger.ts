/**
 * The ledger behind the "approval waiting" status-bar entry.
 *
 * Nothing here imports `vscode`: it owns *which* dialogs are still waiting for a human, and nothing else.
 * A notification — toast or system banner — expires, an unanswered pi dialog does not, so this is the half
 * of the alert that has to be right, and it is the half that can be tested without an editor.
 */

export interface ApprovalLedgerDeps {
  /** Called whenever the outstanding count changes, with the new count. */
  render(open: number): void;
  log(text: string): void;
}

/** Bound on tracked dialogs, so requests nobody ever answers cannot grow the map. */
export const MAX_TRACKED_APPROVALS = 64;

interface Tracked {
  /** Runtime the question came from, so only *its* restart retires it. */
  readonly cwd: string;
  /** Set only for a dialog the requesting extension times out on its own. */
  timer?: ReturnType<typeof setTimeout>;
}

export class ApprovalLedger {
  private readonly open = new Map<string, Tracked>();

  constructor(private readonly deps: ApprovalLedgerDeps) {}

  /**
   * Start following a dialog. `timeoutMs` is the extension's own deadline: past it the runtime has decided
   * for itself, and interrupting for a question that is already closed is worse than not interrupting.
   */
  track(id: string, cwd: string, timeoutMs?: number): void {
    this.stop(id);
    while (this.open.size >= MAX_TRACKED_APPROVALS) {
      const oldest = this.open.keys().next();
      if (oldest.done) break;
      // Say it out loud: the count below this line is no longer the number of parked dialogs.
      this.deps.log(
        `[notify] dropped an unanswered dialog from the count (over ${MAX_TRACKED_APPROVALS} in flight)`,
      );
      this.open.delete(oldest.value);
    }
    this.open.set(id, {
      cwd,
      timer:
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => this.settle(id), timeoutMs),
    });
    this.deps.render(this.open.size);
  }

  /** Stop following one dialog: answered here, answered elsewhere, or its runtime went away. */
  settle(id: string): void {
    if (!this.stop(id)) return;
    this.deps.render(this.open.size);
  }

  /**
   * Stop following everything one runtime was asking. Scoped by cwd on purpose: several workspace folders
   * can each be parked on their own question, and restarting one must not silence the others.
   */
  clearRuntime(cwd: string): void {
    let changed = false;
    for (const [id, tracked] of [...this.open]) {
      if (tracked.cwd !== cwd) continue;
      this.stop(id);
      changed = true;
    }
    if (changed) this.deps.render(this.open.size);
  }

  has(id: string): boolean {
    return this.open.has(id);
  }

  size(): number {
    return this.open.size;
  }

  /** Forget everything (the status-bar entry that displayed the count is going away with it). */
  dispose(): void {
    for (const id of [...this.open.keys()]) this.stop(id);
    this.open.clear();
  }

  private stop(id: string): boolean {
    const tracked = this.open.get(id);
    if (!tracked) return false;
    if (tracked.timer) clearTimeout(tracked.timer);
    this.open.delete(id);
    return true;
  }
}
