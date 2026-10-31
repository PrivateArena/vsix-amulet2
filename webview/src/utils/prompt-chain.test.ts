import { describe, expect, it } from 'vitest';
import { splitPromptChain } from './prompt-chain';

/** Prompt templates the runtime reports; extension commands are excluded. */
const KNOWN = new Set([
  'architect',
  'maintainer',
  'delegate',
  'skill:research',
]);
const isCommand = (name: string) => KNOWN.has(name);

describe('splitPromptChain', () => {
  it('keeps plain text and single commands intact', () => {
    expect(splitPromptChain('fix the build', isCommand)).toEqual([
      'fix the build',
    ]);
    expect(
      splitPromptChain('/architect "write plan for auth"', isCommand),
    ).toEqual(['/architect "write plan for auth"']);
  });

  it('splits one part per known command token', () => {
    expect(
      splitPromptChain(
        '/architect "write plan for X" /maintainer "fix the flaky test"',
        isCommand,
      ),
    ).toEqual([
      '/architect "write plan for X"',
      '/maintainer "fix the flaky test"',
    ]);
  });

  it('splits argument-less commands and keeps newline args attached', () => {
    expect(
      splitPromptChain('/delegate /maintainer "fix it"', isCommand),
    ).toEqual(['/delegate', '/maintainer "fix it"']);
    expect(
      splitPromptChain(
        '/architect step one\nstep two /maintainer go',
        isCommand,
      ),
    ).toEqual(['/architect step one\nstep two', '/maintainer go']);
  });

  it('does not split inside quotes or on unknown / extension commands', () => {
    expect(
      splitPromptChain('/architect "review /maintainer notes"', isCommand),
    ).toEqual(['/architect "review /maintainer notes"']);
    expect(
      splitPromptChain("/architect 'read /maintainer.md' now", isCommand),
    ).toEqual(["/architect 'read /maintainer.md' now"]);
    expect(
      splitPromptChain('/architect use /settings then stop', isCommand),
    ).toEqual(['/architect use /settings then stop']);
  });

  it('leaves messages alone when the first token is not a command', () => {
    expect(
      splitPromptChain('use /architect then /maintainer', isCommand),
    ).toEqual(['use /architect then /maintainer']);
  });

  it('supports skill command names and collapses whitespace around parts', () => {
    expect(
      splitPromptChain('/skill:research  topic  /architect go', isCommand),
    ).toEqual(['/skill:research  topic', '/architect go']);
  });

  it('treats a repeat of the leading command as an argument', () => {
    expect(
      splitPromptChain('/architect compare /architect v2', isCommand),
    ).toEqual(['/architect compare /architect v2']);
    // ...but the same name may open a later link once another command ran.
    expect(
      splitPromptChain('/architect a /maintainer b /architect c', isCommand),
    ).toEqual(['/architect a', '/maintainer b', '/architect c']);
  });

  it('is not confused by apostrophes, comment slashes or unbalanced quotes', () => {
    expect(
      splitPromptChain("/architect fix don't break /maintainer go", isCommand),
    ).toEqual(["/architect fix don't break", '/maintainer go']);
    expect(
      splitPromptChain('/architect // note /maintainer go', isCommand),
    ).toEqual(['/architect // note', '/maintainer go']);
    expect(
      splitPromptChain('/architect "unended /maintainer go', isCommand),
    ).toEqual(['/architect "unended /maintainer go']);
  });
});
