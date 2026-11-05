import { describe, expect, it } from 'vitest';
import { copySourceOf, rawSourceOf, registerCopySource } from './md-units';

/**
 * The registry is keyed by element in a `WeakMap`, so any object works as the key: nothing here
 * touches the DOM, and the test environment has none.
 */
const element = () => ({}) as Element;

describe('registerCopySource / rawSourceOf', () => {
  it('hands the copy path the text on screen and the run path the original', () => {
    const el = element();
    registerCopySource(el, '/media/user/home/app.ts', {
      raw: '/media/jang/home/app.ts',
    });
    expect(copySourceOf(el)).toBe('/media/user/home/app.ts');
    expect(rawSourceOf(el)).toBe('/media/jang/home/app.ts');
  });

  it('has one source when Privacy mode is off', () => {
    const el = element();
    registerCopySource(el, '/media/jang/home/app.ts', {
      raw: '/media/jang/home/app.ts',
    });
    expect(rawSourceOf(el)).toBe(copySourceOf(el));
  });

  it('treats a unit registered without a raw copy as uncensored', () => {
    const el = element();
    registerCopySource(el, 'plain thinking', { pre: true });
    expect(rawSourceOf(el)).toBe('plain thinking');
  });

  it('forgets a re-render that removed the censoring', () => {
    const el = element();
    registerCopySource(el, '/media/user/home', { raw: '/media/jang/home' });
    registerCopySource(el, '/media/jang/home', { raw: '/media/jang/home' });
    expect(copySourceOf(el)).toBe('/media/jang/home');
    expect(rawSourceOf(el)).toBe('/media/jang/home');
  });

  it('says nothing about an element it never saw', () => {
    expect(copySourceOf(element())).toBeUndefined();
    expect(rawSourceOf(element())).toBeUndefined();
    expect(rawSourceOf(null)).toBeUndefined();
    registerCopySource(null, 'ignored');
  });
});
