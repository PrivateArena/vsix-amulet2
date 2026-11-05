import { describe, expect, it } from 'vitest';
import {
  builtinPrivacyRules,
  compilePrivacyRules,
  describePrivacyIssue,
  redactWithRules,
} from './privacy';

/** One declared rule, applied the way the webview applies the whole list. */
const redact = (text: string, ...rules: unknown[]): string =>
  redactWithRules(text, compilePrivacyRules(rules).rules);

describe('compilePrivacyRules', () => {
  it('accepts a literal search/replace pair', () => {
    const { rules, issues } = compilePrivacyRules([
      { search: '/media/jang/home', replace: '/media/user/home' },
    ]);
    expect(issues).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0].literal).toBe(true);
    expect(rules[0].source.search).toBe('/media/jang/home');
  });

  it('reports a rule it cannot use and keeps the others', () => {
    const { rules, issues } = compilePrivacyRules([
      { replace: 'no needle' },
      'not an object',
      { search: 'ok', replace: 'x' },
      // A literal is never an invalid expression: `[` is just a bracket.
      { search: 'a[b', replace: 'y' },
      { pattern: '([unclosed', replace: 'z' },
      { search: 'no replacement' },
    ] as unknown[]);
    expect(rules.map((r) => r.label)).toEqual(['"ok"', '"a[b"']);
    expect(issues.map((i) => i.error)).toEqual([
      'needs a "search" or a "pattern"',
      'not an object',
      expect.stringMatching(/^invalid pattern: /),
      '"replace" must be a string',
    ]);
    expect(issues[1].label).toBe('rule #2');
    expect(issues[2].label).toBe('/([unclosed/');
  });

  it('prefers a pattern over a search when both are declared, and says so', () => {
    const { rules, issues } = compilePrivacyRules([
      { search: 'lit', pattern: 'p.c', replace: 'X' },
    ]);
    expect(rules[0].literal).toBe(false);
    expect(describePrivacyIssue(issues[0])).toBe(
      '"lit": "search" ignored because "pattern" is set',
    );
    // `lit` never applies: the compiled rule carries the pattern only.
    expect(
      redact('pic lit', { search: 'lit', pattern: 'p.c', replace: 'X' }),
    ).toBe('X lit');
  });

  it('reports a non-list setting once instead of throwing', () => {
    const { rules, issues } = compilePrivacyRules({
      search: 'x',
      replace: 'y',
    });
    expect(rules).toEqual([]);
    expect(describePrivacyIssue(issues[0])).toBe('privacyRules: not a list');
  });

  it('treats an absent or empty setting as no rules', () => {
    expect(compilePrivacyRules(undefined).rules).toEqual([]);
    expect(compilePrivacyRules(null).rules).toEqual([]);
    expect(compilePrivacyRules([]).rules).toEqual([]);
  });
});

describe('redactWithRules', () => {
  it('replaces every occurrence of a literal, dollar signs included', () => {
    expect(redact('a.cc a.cc', { search: 'a.cc', replace: 'x$y' })).toBe(
      'x$y x$y',
    );
  });

  it('honours regex groups and flags', () => {
    const text = 'key=SECRET1 and key=SECRET2';
    expect(
      redact(text, { pattern: 'key=(\\w+)', replace: 'key=[$1]', flags: 'i' }),
    ).toBe('key=[SECRET1] and key=[SECRET2]');
  });

  it('replaces all matches even without a `g` flag in the declaration', () => {
    expect(redact('aa aa', { pattern: 'a', replace: 'b' })).toBe('bb bb');
  });

  it('drops a sticky flag rather than leaking the skipped prefix', () => {
    expect(redact('aa aa', { pattern: 'a', replace: 'b', flags: 'y' })).toBe(
      'bb bb',
    );
  });

  it('applies rules in declaration order', () => {
    expect(
      redact(
        'rustdesk',
        { search: 'rustdesk', replace: 'remote-tool' },
        { search: 'remote-tool', replace: 'tool' },
      ),
    ).toBe('tool');
  });

  it('does not restart a previous match because of lastIndex', () => {
    const rules = compilePrivacyRules([{ search: 'ab', replace: 'X' }]).rules;
    expect(redactWithRules('ab ab', rules)).toBe('X X');
    expect(redactWithRules('ab ab', rules)).toBe('X X');
  });

  it('leaves empty text alone', () => {
    expect(redact('', { search: 'a', replace: 'b' })).toBe('');
    expect(redactWithRules('untouched', [])).toBe('untouched');
  });
});

describe('builtinPrivacyRules', () => {
  const rules = compilePrivacyRules(builtinPrivacyRules('jang')).rules;
  const cut = (text: string) => redactWithRules(text, rules);

  it('censors a user name used as a path segment', () => {
    expect(cut('/media/jang/home/PortableApp/rustdesk')).toBe(
      '/media/username/home/PortableApp/rustdesk',
    );
    expect(cut('C:\\Users\\jang\\code')).toBe('C:\\Users\\username\\code');
    expect(cut('look at /home/jang')).toBe('look at /home/username');
    expect(cut('cd /home/jang && ls')).toBe('cd /home/username && ls');
    // Multi-line tool output: a path at the head of a line, not of the whole string.
    expect(cut('total 4\njang/home/x.ts\n./jang/repo\n')).toBe(
      'total 4\nusername/home/x.ts\n./username/repo\n',
    );
  });

  it('leaves a name that is not a path segment alone', () => {
    expect(cut('jangfo and jangray')).toBe('jangfo and jangray');
    expect(cut('/media/jang-2/x')).toBe('/media/jang-2/x');
    expect(cut('the user jang approved it')).toBe('the user jang approved it');
  });

  it('is empty without a usable user name', () => {
    expect(builtinPrivacyRules('')).toEqual([]);
    expect(builtinPrivacyRules('a')).toEqual([]);
    expect(builtinPrivacyRules('  ')).toEqual([]);
  });
});
