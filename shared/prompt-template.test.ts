import { describe, expect, it } from 'vitest';
import {
  analysePromptTemplate,
  formatSkillBlock,
  mergeToSingleLine,
  parseCommandArgs,
  parsePromptInvocation,
  readTemplateFrontmatter,
  stripTemplateFrontmatter,
  substitutePromptArgs,
} from './prompt-template';

/**
 * Every expectation here is pi 1.5.0 behaviour: `substituteArgs`/`parseCommandArgs`
 * (`dist/core/prompt-templates.js:11-85`), the command split of `expandPromptTemplate`
 * (`:252-266`), the skill block of `_expandSkillCommand`
 * (`dist/core/agent-session.js:1745-1765`) and the table in `docs/prompt-templates.md`.
 */

describe('parseCommandArgs', () => {
  it('splits on whitespace and strips both quote styles', () => {
    expect(parseCommandArgs('one two')).toEqual(['one', 'two']);
    expect(parseCommandArgs('"one two" \'three four\'')).toEqual([
      'one two',
      'three four',
    ]);
  });

  it('keeps a quoted empty string as an empty argument', () => {
    expect(parseCommandArgs('"" x')).toEqual(['', 'x']);
    expect(parseCommandArgs("''")).toEqual(['']);
  });

  it('treats a newline as an argument separator, like pi does', () => {
    // This is why a chained draft loses its second command: those tokens are simply
    // more arguments of the first one, and an unused argument is dropped without a word.
    expect(parseCommandArgs('"123"\n/prompt2 "345"')).toEqual([
      '123',
      '/prompt2',
      '345',
    ]);
  });

  it('has no escapes, and an unterminated quote swallows the rest', () => {
    // The backslash is literal, so the inner quote ends the token: pi's own answer.
    expect(parseCommandArgs('"a \\" b')).toEqual(['a \\', 'b']);
    expect(parseCommandArgs('"unended tail')).toEqual(['unended tail']);
    expect(parseCommandArgs('x "unended tail')).toEqual(['x', 'unended tail']);
  });
});

describe('parsePromptInvocation', () => {
  it('mirrors the anchor: name up to the first space, arguments the rest verbatim', () => {
    expect(parsePromptInvocation('/architect "123"\n/prompt2 "345"')).toEqual({
      name: 'architect',
      argsString: '"123"\n/prompt2 "345"',
    });
    expect(parsePromptInvocation('/ask')).toEqual({
      name: 'ask',
      argsString: '',
    });
    expect(parsePromptInvocation('/skill:pdf-tools read x')).toEqual({
      name: 'skill:pdf-tools',
      argsString: 'read x',
    });
  });

  it('refuses anything that does not start with a slash', () => {
    expect(parsePromptInvocation('read /maintainer please')).toBeNull();
    expect(parsePromptInvocation(' /leading-space')).toBeNull();
    expect(parsePromptInvocation('/')).toBeNull();
  });
});

describe('substitutePromptArgs', () => {
  const args = ['alpha', 'beta', 'gamma'];

  it('fills positional and whole-list placeholders', () => {
    expect(substitutePromptArgs('$1 then $2', args)).toBe('alpha then beta');
    expect(substitutePromptArgs('$@', args)).toBe('alpha beta gamma');
    expect(substitutePromptArgs('$ARGUMENTS', args)).toBe('alpha beta gamma');
  });

  it('renders a missing positional argument as nothing', () => {
    expect(substitutePromptArgs('[$5]', args)).toBe('[]');
    // $2 is the *second* argument: an unused position is empty, never a shift-up.
    expect(substitutePromptArgs('[$2]', ['only'])).toBe('[]');
    expect(substitutePromptArgs('[$1]', ['only'])).toBe('[only]');
  });

  it('applies defaults on a missing OR an empty argument', () => {
    expect(substitutePromptArgs('${1:-fallback}', [])).toBe('fallback');
    expect(substitutePromptArgs('${1:-fallback}', [''])).toBe('fallback');
    expect(substitutePromptArgs('${@:-none}', [])).toBe('none');
    expect(substitutePromptArgs('${ARGUMENTS:-none}', ['a'])).toBe('a');
    expect(substitutePromptArgs('${1:-a}b}', ['x'])).toBe('xb}');
  });

  it('slices the argument list bash-style', () => {
    expect(substitutePromptArgs('${@:2}', args)).toBe('beta gamma');
    expect(substitutePromptArgs('${@:2:2}', args)).toBe('beta gamma');
    expect(substitutePromptArgs('${@:3:1}', args)).toBe('gamma');
    // pi clamps position 0 to the first argument.
    expect(substitutePromptArgs('${@:0}', args)).toBe('alpha beta gamma');
    expect(substitutePromptArgs('${@:9}', args)).toBe('');
  });

  it('never substitutes into an argument value', () => {
    expect(substitutePromptArgs('$1', ['$2 $@'])).toBe('$2 $@');
    expect(substitutePromptArgs('${1:-$2}', [])).toBe('$2');
  });

  it('leaves a brace form it does not know alone', () => {
    // A `$` inside `{…}` is never adjacent to the index, so neither form is a placeholder.
    expect(substitutePromptArgs('${1} ${@}', args)).toBe('${1} ${@}');
  });

  it('handles the real architect template placeholder', () => {
    expect(substitutePromptArgs("Draft a plan for: '$1'.", ['add auth'])).toBe(
      "Draft a plan for: 'add auth'.",
    );
  });
});

describe('analysePromptTemplate', () => {
  it('counts the highest positional index the template actually reads', () => {
    expect(analysePromptTemplate('a $1 b ${3:-x} c').positional).toBe(3);
    expect(analysePromptTemplate('no placeholder').positional).toBe(0);
  });

  it('reports a positional default as that field placeholder', () => {
    expect(analysePromptTemplate('${2:-correctness}').defaults).toEqual({
      2: 'correctness',
    });
  });

  it('knows a list placeholder needs the whole argument list', () => {
    expect(analysePromptTemplate('$@')).toMatchObject({
      positional: 0,
      usesRest: true,
    });
    expect(analysePromptTemplate('${@:2:3}')).toMatchObject({
      positional: 4,
      usesRest: true,
    });
    expect(analysePromptTemplate('${@:-none}').usesRest).toBe(true);
  });

  it('scans the whole file, not just the first hit', () => {
    expect(
      analysePromptTemplate('$1\nsome prose\n$ARGUMENTS\n${4:-d}').positional,
    ).toBe(4);
  });
});

describe('skill block', () => {
  it("is pi's own `<skill …>` envelope", () => {
    expect(
      formatSkillBlock({
        name: 'pdf-tools',
        location: '/home/u/.pi/agent/skills/pdf-tools/SKILL.md',
        baseDir: '/home/u/.pi/agent/skills/pdf-tools',
        body: 'Do the thing.',
        args: 'on file.pdf',
      }),
    ).toBe(
      '<skill name="pdf-tools" location="/home/u/.pi/agent/skills/pdf-tools/SKILL.md">\n' +
        'References are relative to /home/u/.pi/agent/skills/pdf-tools.\n' +
        '\n' +
        'Do the thing.\n' +
        '</skill>\n' +
        '\n' +
        'on file.pdf',
    );
  });

  it('omits the trailing argument block when there are none', () => {
    expect(
      formatSkillBlock({
        name: 's',
        location: '/p/SKILL.md',
        baseDir: '/p',
        body: 'b',
        args: '',
      }),
    ).not.toMatch(/\n\n$/);
  });
});

describe('frontmatter', () => {
  const file =
    '---\ndescription: "Does a thing"\nargument-hint: <file> <mode>\n---\nBody $1\n';

  it('reads the two keys pi reads', () => {
    expect(readTemplateFrontmatter(file, 'description')).toBe('Does a thing');
    expect(readTemplateFrontmatter(file, 'argument-hint')).toBe(
      '<file> <mode>',
    );
    expect(readTemplateFrontmatter(file, 'name')).toBeUndefined();
  });

  it('drops the block from the body and normalises newlines', () => {
    expect(stripTemplateFrontmatter('---\nd: x\r\n---\nBody\n')).toBe('Body');
    expect(stripTemplateFrontmatter('---\nd: x\n---\n\n\nBody')).toBe('Body');
    expect(stripTemplateFrontmatter('No frontmatter\n\nat all')).toBe(
      'No frontmatter\n\nat all',
    );
  });

  it('leaves a file with no closing fence untrimmed, because pi does', () => {
    // `extractFrontmatter` hands back the normalised content untouched when there is no fence,
    // and `loadTemplateFromFile` stores exactly that as the template body.
    expect(stripTemplateFrontmatter('Body $1\n')).toBe('Body $1\n');
    expect(stripTemplateFrontmatter('\n\nBody\n')).toBe('\n\nBody\n');
    expect(stripTemplateFrontmatter('---\nbroken')).toBe('---\nbroken');
  });
});

describe('mergeToSingleLine', () => {
  it('folds every line of a pasted argument into one sentence', () => {
    expect(mergeToSingleLine('line one\nline two\rthree\n\nfour')).toBe(
      'line one line two three four',
    );
    expect(mergeToSingleLine('  padded   value  ')).toBe('padded value');
  });

  it('keeps tabs inside a value as they are', () => {
    expect(mergeToSingleLine('a\tb')).toBe('a\tb');
  });
});
