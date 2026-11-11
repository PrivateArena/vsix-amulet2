import { describe, expect, it } from 'vitest';
import type { CommandInfo, PromptResource } from '../../../shared/protocol';
import {
  argFieldsOf,
  buildArgs,
  expandedTextOf,
  hiddenArgsOf,
  initialFormOf,
  joinDraft,
  leadingPromptCommand,
  promptTargetOf,
  type PromptForm,
  type PromptTarget,
} from './prompt-insert';

/**
 * The client-side half of pi's expansion: which draft is an expandable command, which fields
 * that command needs, and what text results. pi's own behaviour is pinned in
 * `shared/prompt-template.test.ts`; this is the part that decides what the human sees.
 */

const row = (
  name: string,
  source: string,
  description?: string,
): CommandInfo => ({
  name,
  source,
  description,
});

const COMMANDS: CommandInfo[] = [
  row('architect', 'prompt', 'Plan a thing'),
  row('maintainer', 'prompt'),
  row('gatec', 'extension', 'Permission gate'),
  row('skill:pdf-tools', 'skill'),
  row('pdf-tools', 'prompt', 'A template that is not the skill'),
];

const target = (over: Partial<PromptTarget> = {}): PromptTarget => ({
  name: 'architect',
  kind: 'prompt',
  label: 'architect',
  range: { start: 0, end: 10 },
  typedArgs: [],
  invocationText: '/architect',
  ...over,
});

const form = (over: Partial<PromptForm> = {}): PromptForm => ({
  args: [],
  rest: '',
  restInitial: '',
  ...over,
});

const resource = (over: Partial<PromptResource> = {}): PromptResource => ({
  name: 'architect',
  kind: 'prompt',
  path: '/home/u/.pi/agent/prompts/architect.md',
  body: "Draft a plan for: '$1'.",
  ...over,
});

describe('leadingPromptCommand', () => {
  it('recognises a template invocation and keeps its raw argument string', () => {
    expect(leadingPromptCommand('/architect "add auth" now', COMMANDS)).toEqual(
      {
        name: 'architect',
        kind: 'prompt',
        description: 'Plan a thing',
        argsString: '"add auth" now',
      },
    );
  });

  it('leaves prose, unknown tokens and extension commands alone', () => {
    expect(leadingPromptCommand('read /architect please', COMMANDS)).toBeNull();
    expect(leadingPromptCommand('/nope go', COMMANDS)).toBeNull();
    expect(leadingPromptCommand('/gatec status', COMMANDS)).toBeNull();
    expect(leadingPromptCommand('/maintainer', COMMANDS)).toEqual({
      name: 'maintainer',
      kind: 'prompt',
      argsString: '',
      description: undefined,
    });
  });

  it("requires pi's literal namespace before a skill name", () => {
    // `/pdf-tools` is prose to pi (its expander matches the `/skill:` prefix), and there is a
    // real template with that name, so the wrong reading would expand the wrong file.
    expect(leadingPromptCommand('/pdf-tools read', COMMANDS)).toMatchObject({
      kind: 'prompt',
      name: 'pdf-tools',
    });
    expect(leadingPromptCommand('/skill:pdf-tools read', COMMANDS)).toEqual({
      name: 'skill:pdf-tools',
      kind: 'skill',
      argsString: 'read',
      description: undefined,
    });
  });
});

describe('promptTargetOf', () => {
  it("tokenises a template's arguments like pi does", () => {
    expect(
      promptTargetOf(
        { name: 'architect', kind: 'prompt', argsString: '"one two" three' },
        { start: 0, end: 20 },
      ),
    ).toMatchObject({ label: 'architect', typedArgs: ['one two', 'three'] });
  });

  it("keeps a skill's arguments as the one string pi appends verbatim", () => {
    expect(
      promptTargetOf(
        {
          name: 'skill:pdf-tools',
          kind: 'skill',
          argsString: 'read\n  file.pdf',
        },
        { start: 0, end: 20 },
      ),
    ).toMatchObject({ label: 'pdf-tools', typedArgs: ['read\n  file.pdf'] });
  });
});

describe('argFieldsOf', () => {
  it('asks for exactly the positions the template reads', () => {
    const fields = argFieldsOf(
      target(),
      resource({ body: '$1 and ${3:-default}' }),
    );
    expect(fields.map((f) => f.label)).toEqual(['$1', '$2', '$3']);
    expect(fields[2]).toMatchObject({
      kind: 'arg',
      position: 2,
      placeholder: 'default',
    });
  });

  it('adds the argument-list field only when the template uses it', () => {
    const fields = argFieldsOf(target(), resource({ body: '$1 then $@' }));
    expect(fields.map((f) => `${f.label}/${f.kind}`)).toEqual([
      '$1/arg',
      '$@/rest',
    ]);
  });

  it('falls back to the hint tokens when a position has no default', () => {
    const fields = argFieldsOf(
      target(),
      resource({ body: '$1 then $2', hint: '<file> <mode>' }),
    );
    expect(fields.map((f) => f.placeholder)).toEqual(['<file>', '<mode>']);
  });

  it('grows for arguments that were already typed', () => {
    const typed = target({ typedArgs: ['a', 'b', 'c'] });
    expect(
      argFieldsOf(typed, resource({ body: '$1' })).map((f) => f.label),
    ).toEqual(['$1', '$2', '$3']);
  });

  it('caps the rendered fields and says what it cannot show', () => {
    const res = resource({ body: '${@:1:40}' });
    expect(
      argFieldsOf(target(), res).filter((f) => f.kind === 'arg'),
    ).toHaveLength(8);
    expect(hiddenArgsOf(target(), res)).toBe(32);
  });

  it('gives a skill one free-text field', () => {
    const skill = target({
      kind: 'skill',
      name: 'skill:pdf-tools',
      label: 'pdf-tools',
    });
    expect(argFieldsOf(skill, resource({ kind: 'skill' }))).toEqual([
      {
        kind: 'rest',
        position: 0,
        label: 'Arguments',
        placeholder: 'Appended after the skill instructions',
      },
    ]);
  });
});

describe('initialFormOf', () => {
  it('puts each typed argument in its own position', () => {
    const t = target({ typedArgs: ['a', 'b'] });
    expect(initialFormOf(t, resource({ body: '$1 $2' }))).toEqual({
      args: ['a', 'b'],
      rest: '',
      restInitial: '',
    });
  });

  it('folds every typed argument into the list box when there are no positions', () => {
    const t = target({ typedArgs: ['a', 'b'] });
    // pi's `$@` is exactly those arguments joined, so nothing is invented here.
    expect(initialFormOf(t, resource({ body: '$@' }))).toEqual({
      args: [],
      rest: 'a b',
      restInitial: 'a b',
    });
  });

  it('gives a skill the one verbatim string pi appends', () => {
    const t = target({
      kind: 'skill',
      name: 'skill:pdf-tools',
      label: 'pdf-tools',
      typedArgs: ['read\nfile'],
    });
    expect(initialFormOf(t, resource({ kind: 'skill' }))).toEqual({
      args: [],
      rest: 'read\nfile',
      restInitial: 'read\nfile',
    });
  });
});

describe('buildArgs / expandedTextOf', () => {
  it('folds a multi-line argument the human typed', () => {
    const f = form({ args: ['line one\nline two\n'] });
    expect(buildArgs(target(), f)).toEqual(['line one line two']);
    expect(expandedTextOf(target(), resource(), f)).toBe(
      "Draft a plan for: 'line one line two'.",
    );
  });

  it('leaves an untouched prefill exactly as the draft had it', () => {
    const t = target({ typedArgs: ['a   b', 'c'] });
    const res = resource({ body: '[$1][$2][$@]' });
    // pi received `a   b` with its spacing and would have inserted it verbatim.
    expect(buildArgs(t, initialFormOf(t, res))).toEqual(['a   b', 'c']);
  });

  it('substitutes arguments the form has no box for', () => {
    const many = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
    const t = target({ typedArgs: many });
    const res = resource({ body: '$9 and $@' });
    expect(expandedTextOf(t, res, initialFormOf(t, res))).toBe(
      `a9 and ${many.join(' ')}`,
    );
  });

  it('appends the $@ box as one more argument', () => {
    const res = resource({ body: '$1 / $@' });
    const f = form({ args: ['first'], rest: 'and the rest' });
    expect(buildArgs(target(), f)).toEqual(['first', 'and the rest']);
    expect(expandedTextOf(target(), res, f)).toBe('first / first and the rest');
  });

  it('leaves an omitted argument empty, exactly as pi renders $2 with one argument', () => {
    const res = resource({ body: '[$1][$2]' });
    expect(expandedTextOf(target(), res, form({ args: ['a', ''] }))).toBe(
      '[a][]',
    );
  });

  it("builds pi's own skill envelope", () => {
    const t = target({
      kind: 'skill',
      name: 'skill:pdf-tools',
      label: 'pdf-tools',
    });
    const res: PromptResource = {
      name: 'skill:pdf-tools',
      kind: 'skill',
      path: '/u/.pi/agent/skills/pdf-tools/SKILL.md',
      baseDir: '/u/.pi/agent/skills/pdf-tools',
      body: 'Use pdftotext.',
    };
    expect(expandedTextOf(t, res, form({ rest: 'read file.pdf' }))).toBe(
      '<skill name="pdf-tools" location="/u/.pi/agent/skills/pdf-tools/SKILL.md">\n' +
        'References are relative to /u/.pi/agent/skills/pdf-tools.\n' +
        '\nUse pdftotext.\n</skill>\n\nread file.pdf',
    );
  });
});

describe('joinDraft', () => {
  it('starts the draft when the command was the whole message', () => {
    expect(joinDraft('', 'BODY', '')).toEqual({ value: 'BODY', caret: 4 });
  });

  it('separates a one-line block from the prose around it', () => {
    const out = joinDraft('please read this', 'BODY', ' then summarise');
    expect(out.value).toBe('please read this BODY then summarise');
    expect(out.caret).toBe('please read this BODY'.length);
  });

  it('gives a paragraph a blank line of its own', () => {
    const out = joinDraft('please read this', 'PART ONE\nPART TWO', 'then go');
    expect(out.value).toBe('please read this\n\nPART ONE\nPART TWO\n\nthen go');
    expect(out.caret).toBe('please read this\n\nPART ONE\nPART TWO'.length);
  });

  it('keeps the line structure the human already made', () => {
    expect(joinDraft('intro\n', 'BODY', '\ntail').value).toBe(
      'intro\nBODY\ntail',
    );
    expect(joinDraft('intro ', 'BODY', ' tail').value).toBe('intro BODY tail');
  });

  it('does not carry trailing whitespace of the block into the draft', () => {
    expect(joinDraft('', 'BODY\n\n', '').value).toBe('BODY');
  });
});
