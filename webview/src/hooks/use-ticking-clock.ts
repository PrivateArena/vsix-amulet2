import { useEffect, useState } from 'react';

/** Resolution of the live elapsed-time counters. */
const TICK_MS = 1000;

/**
 * Wall-clock `Date.now()` that refreshes once a second while `active`.
 *
 * Drives the elapsed time on a running tool card. Cards that already settled hold
 * no timer and an idle transcript never wakes on a clock — the caller passes its
 * own running state, so the interval lives exactly as long as the call does.
 */
export function useTickingClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  return now;
}
