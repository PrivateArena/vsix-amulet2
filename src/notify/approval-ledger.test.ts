import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalLedger, MAX_TRACKED_APPROVALS } from './approval-ledger';

function make() {
  const rendered: number[] = [];
  const logs: string[] = [];
  const ledger = new ApprovalLedger({
    render: (open) => rendered.push(open),
    log: (text) => logs.push(text),
  });
  return { ledger, rendered, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ApprovalLedger', () => {
  it('counts a dialog from the moment it is claimed', () => {
    const { ledger, rendered } = make();
    ledger.track('gate-1', '/repo/a');
    expect(ledger.has('gate-1')).toBe(true);
    expect(rendered).toEqual([1]);
  });

  it('counts several dialogs, and stops at the one that was answered', () => {
    const { ledger, rendered } = make();
    ledger.track('gate-1', '/repo/a');
    ledger.track('gate-2', '/repo/a');
    ledger.settle('gate-1');
    expect(ledger.size()).toBe(1);
    expect(rendered).toEqual([1, 2, 1]);
  });

  it('ignores an answer for something it never saw', () => {
    const { ledger, rendered } = make();
    ledger.settle('stranger');
    expect(rendered).toEqual([]);
  });

  it('renders again when the same dialog is claimed twice', () => {
    const { ledger } = make();
    ledger.track('gate-1', '/repo/a');
    // A re-posted request must not inflate the count — or leak its first timer.
    const before = vi.getTimerCount();
    ledger.track('gate-1', '/repo/a');
    expect(ledger.size()).toBe(1);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears only the runtime that went away', () => {
    const { ledger, rendered } = make();
    ledger.track('gate-a1', '/repo/a');
    ledger.track('gate-b1', '/repo/b');
    ledger.clearRuntime('/repo/a');
    expect(ledger.has('gate-a1')).toBe(false);
    expect(ledger.has('gate-b1')).toBe(true);
    expect(rendered.at(-1)).toBe(1);
  });

  it('is quiet when a runtime with nothing parked on it restarts', () => {
    const { ledger, rendered } = make();
    ledger.track('gate-b1', '/repo/b');
    rendered.length = 0;
    ledger.clearRuntime('/repo/a');
    expect(rendered).toEqual([]);
  });

  it('drops a dialog the extension decided on its own', () => {
    const { ledger, rendered } = make();
    // pi-subagent's ceiling question waits five minutes for a human, then enforces the budget.
    ledger.track('ceiling-1', '/repo/a', 300_000);
    expect(ledger.has('ceiling-1')).toBe(true);
    vi.advanceTimersByTime(300_000);
    expect(ledger.has('ceiling-1')).toBe(false);
    expect(rendered.at(-1)).toBe(0);
  });

  it('waits indefinitely for a dialog whose extension has no timeout', () => {
    const { ledger } = make();
    // pi-gate with `promptTimeoutMs: 0`: the question is parked until a human answers it.
    ledger.track('gate-1', '/repo/a');
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(ledger.has('gate-1')).toBe(true);
  });

  it('retires a pending timer when the dialog is answered first', () => {
    const { ledger } = make();
    ledger.track('ceiling-1', '/repo/a', 300_000);
    ledger.settle('ceiling-1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says so when it has to drop a dialog it can no longer count', () => {
    const { ledger, logs } = make();
    for (let i = 0; i < MAX_TRACKED_APPROVALS; i++) {
      ledger.track(`gate-${i}`, '/repo/a');
    }
    ledger.track('overflow', '/repo/a');
    expect(ledger.size()).toBe(MAX_TRACKED_APPROVALS);
    expect(logs.join(' ')).toContain('dropped an unanswered dialog');
    expect(ledger.has('overflow')).toBe(true);
  });

  it('leaves no timer behind when the service is torn down', () => {
    const { ledger } = make();
    ledger.track('gate-1', '/repo/a', 1_000);
    ledger.track('gate-2', '/repo/a', 2_000);
    ledger.dispose();
    expect(ledger.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
