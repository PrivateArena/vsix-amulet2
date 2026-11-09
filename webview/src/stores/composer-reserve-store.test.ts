import { afterEach, describe, expect, it } from 'vitest';
import {
  clearComposerReserve,
  reserveForComposer,
  useComposerReserveStore,
} from './composer-reserve-store';

/** The store only ever writes `padding-bottom`, so a stub element is a real test. */
function fakeLog(): { log: HTMLElement; writes: () => string[] } {
  const written: string[] = [];
  let value = '';
  const style = {
    get paddingBottom() {
      return value;
    },
    set paddingBottom(next: string) {
      written.push(next);
      value = next;
    },
  };
  return { log: { style } as unknown as HTMLElement, writes: () => written };
}

const store = () => useComposerReserveStore.getState();

afterEach(() => {
  store().registerLog(null);
});

describe('composer reserve', () => {
  it('does nothing while no transcript is mounted', () => {
    expect(() => reserveForComposer(120)).not.toThrow();
  });

  it('reserves the composer height plus the gap under the last row', () => {
    const { log, writes } = fakeLog();
    store().registerLog(log);
    reserveForComposer(80);
    expect(writes()).toEqual(['84px']);
  });

  it('writes nothing when the height did not change', () => {
    const { log, writes } = fakeLog();
    store().registerLog(log);
    reserveForComposer(80);
    // The observer fires for sub-pixel growth too; a same-value write would still
    // dirty the element's style, and that is the cost this whole store exists to pay.
    reserveForComposer(80.4);
    expect(writes()).toHaveLength(1);
  });

  it('stops writing once unregistered, and never clears a newer transcript', () => {
    const first = fakeLog();
    const second = fakeLog();
    const unregisterFirst = store().registerLog(first.log);

    unregisterFirst();
    reserveForComposer(80);
    expect(first.writes()).toEqual([]);

    store().registerLog(second.log);
    // A stale handle from the old surface must not retire the new registration.
    unregisterFirst();
    reserveForComposer(60);
    expect(second.writes()).toEqual(['64px']);
  });

  it('hands the bottom padding back when the composer goes away', () => {
    const { log, writes } = fakeLog();
    store().registerLog(log);
    reserveForComposer(80);
    clearComposerReserve();
    expect(writes()).toEqual(['84px', '']);
  });
});
