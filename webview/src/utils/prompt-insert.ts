import type { CommandInfo, PromptResource } from '../../../shared/protocol';
import {
  analysePromptTemplate,
  formatSkillBlock,
  mergeToSingleLine,
  parseCommandArgs,
  parsePromptInvocation,
  substitutePromptArgs,
} from '../../../shared/prompt-template';
import {
  commandName,
  SKILL_COMMAND_PREFIX,
  skillNameOf,
} from './slash-command';

/**
 * Putting one of pi's prompt files into the composer, expanded.
 *
 * pi expands a template by reading its file and substituting `$1`/`$@` — anchored at the
 * *start of a message*, so a draft carrying two `/prompts` loses the second one into the
 * first one's arguments. This module does the same job from the same file, and hands the
 * human prose: what lands in the composer is inert text, so any number of prompts can share
 * one draft, and nothing is sent before the submit button is pressed.
 */

/** Which kind of pi resource the dialog is holding. */
export type PromptKind = 'prompt' | 'skill';

/** One prompt template or skill, chosen, with the draft range its invocation occupies. */
export interface PromptTarget {
  /** pi's own reported name — skills keep their `skill:` namespace. */
  name: string;
  kind: PromptKind;
  /** What the title shows: the name without the namespace. */
  label: string;
  description?: string;
  range: { start: number; end: number };
  /** Arguments already typed after the name, already in field order (a skill's list is one string). */
  typedArgs: string[];
  /** The invocation as the draft held it, so a second Enter can send it after all. */
  invocationText: string;
}

/** A command row that the client may expand itself. */
export interface LeadingPromptCommand {
  name: string;
  kind: PromptKind;
  description?: string;
  /** Everything the human typed after the name, verbatim — pi's own argument string. */
  argsString: string;
}

/**
 * The dialog's view of an invocation: which command, what the title says, where its text
 * goes, and which arguments the human already typed. A skill's arguments are one string
 * because pi appends them verbatim instead of tokenising them (`_expandSkillCommand`).
 */
export function promptTargetOf(
  command: LeadingPromptCommand,
  range: { start: number; end: number },
): PromptTarget {
  const args = command.argsString.trim();
  return {
    name: command.name,
    kind: command.kind,
    label:
      command.kind === 'skill'
        ? skillNameOf(command.name)
        : commandName(command.name),
    description: command.description,
    range,
    invocationText: `/${command.name}${args ? ` ${args}` : ''}`,
    typedArgs:
      command.kind === 'skill'
        ? args
          ? [args]
          : []
        : parseCommandArgs(command.argsString),
  };
}

/**
 * Whether this draft text is one of pi's expandable commands, or null when it is prose, an
 * extension command, or an unrecognised `/token`.
 *
 * The precedence is pi's (`agent-session.js:1658-1680`): an extension command wins over a
 * template of the same name because pi dispatches it before it expands anything, and a skill
 * only counts when the literal `skill:` namespace was typed, because that is what its expander
 * matches — `/pdf-tools` is prose to pi, so it must stay prose here too.
 */
export function leadingPromptCommand(
  text: string,
  commands: CommandInfo[],
): LeadingPromptCommand | null {
  const invocation = parsePromptInvocation(text.trim());
  if (!invocation) return null;
  const name = commandName(invocation.name);
  const row = commands.find((c) => commandName(c.name) === name);
  if (!row) return null;
  if (row.source === 'skill') {
    if (!name.startsWith(SKILL_COMMAND_PREFIX)) return null;
    return {
      name: row.name,
      kind: 'skill',
      description: row.description,
      argsString: invocation.argsString,
    };
  }
  if (row.source !== 'prompt') return null;
  return {
    name: row.name,
    kind: 'prompt',
    description: row.description,
    argsString: invocation.argsString,
  };
}

/** One input of the dialog: a positional argument, or the argument list itself. */
export interface PromptField {
  /** `'arg'` fills `$N`; `'rest'` fills `$@`/`${@:N…}` — and a skill's appended arguments. */
  kind: 'arg' | 'rest';
  /** Position for an `'arg'` field (0-based, so pi's `$1` is position 0). */
  position: number;
  /** pi's own placeholder syntax, so the field says exactly what it fills. */
  label: string;
  placeholder?: string;
}

/** What the form holds, kept apart from the fields that render it. */
export interface PromptForm {
  /** Positional arguments, one entry per argument the draft carried — the form may show fewer. */
  args: string[];
  /** The `$@` box. */
  rest: string;
  /** The `$@` box as it arrived, so an untouched prefill is never rewritten. */
  restInitial: string;
}

/**
 * Ceiling on positional *fields*: a template may reference `${@:1:40}`, and that is an argument
 * list, not a form. The argument array itself is never capped, so every argument the human typed
 * is still substituted — `hiddenArgsOf` says what the form cannot show.
 */
export const MAX_ARG_FIELDS = 8;

/**
 * The fields this resource needs: one per referenced position (capped), plus the list field when
 * the template reads it. A skill has no placeholders of its own — pi appends its arguments under
 * the block — so it always gets exactly one.
 */
export function argFieldsOf(
  target: PromptTarget,
  resource: PromptResource,
): PromptField[] {
  if (target.kind === 'skill') {
    return [
      {
        kind: 'rest',
        position: 0,
        label: 'Arguments',
        placeholder: resource.hint ?? 'Appended after the skill instructions',
      },
    ];
  }
  const shape = analysePromptTemplate(resource.body);
  const hintTokens = (resource.hint ?? '').split(/\s+/).filter(Boolean);
  const count = Math.min(
    Math.max(shape.positional, target.typedArgs.length),
    MAX_ARG_FIELDS,
  );
  const fields: PromptField[] = [];
  for (let i = 1; i <= count; i++) {
    fields.push({
      kind: 'arg',
      position: i - 1,
      label: `$${i}`,
      placeholder:
        shape.defaults[i] ??
        (hintTokens.length === shape.positional
          ? hintTokens[i - 1]
          : undefined),
    });
  }
  if (shape.usesRest) {
    fields.push({
      kind: 'rest',
      position: shape.positional,
      label: '$@',
      placeholder:
        count === 0
          ? (resource.hint ?? 'All arguments')
          : 'Remaining arguments',
    });
  }
  return fields;
}

/** Positions the template reads and the form has no box for (`0` when it shows them all). */
export function hiddenArgsOf(
  target: PromptTarget,
  resource: PromptResource,
): number {
  if (target.kind === 'skill') return 0;
  return Math.max(
    analysePromptTemplate(resource.body).positional - MAX_ARG_FIELDS,
    0,
  );
}

/**
 * The form as it opens: the arguments the human already typed, in the boxes they belong to.
 * A template that reads only `$@` has no positions, so every typed argument goes into the list
 * box — which is precisely what pi would have joined there.
 */
export function initialFormOf(
  target: PromptTarget,
  resource: PromptResource,
): PromptForm {
  if (target.kind === 'skill') {
    const args = target.typedArgs[0] ?? '';
    return { args: [], rest: args, restInitial: args };
  }
  const shape = analysePromptTemplate(resource.body);
  if (shape.usesRest && shape.positional === 0) {
    const joined = target.typedArgs.join(' ');
    return { args: [], rest: joined, restInitial: joined };
  }
  return { args: [...target.typedArgs], rest: '', restInitial: '' };
}

/**
 * The argument array pi would have parsed.
 *
 * A value the human typed into a box is folded onto one line, because the box accepts newlines
 * and an argument is prose the model reads inline. A value that is still exactly what the draft
 * carried is passed through untouched: those bytes are what pi would have received, and folding
 * them would be a divergence this client invented.
 */
export function buildArgs(target: PromptTarget, form: PromptForm): string[] {
  if (target.kind === 'skill') return [];
  const args = form.args.map((value, position) =>
    value === target.typedArgs[position] ? value : mergeToSingleLine(value),
  );
  const rest = restOf(target, form);
  if (rest) args.push(rest);
  return args;
}

/** The list box, folded only when the human changed it. */
const restOf = (_target: PromptTarget, form: PromptForm): string =>
  form.rest === form.restInitial ? form.rest : mergeToSingleLine(form.rest);

/**
 * The text the composer would receive: the template with its arguments substituted, or pi's own
 * `<skill …>` envelope.
 */
export function expandedTextOf(
  target: PromptTarget,
  resource: PromptResource,
  form: PromptForm,
): string {
  if (target.kind === 'skill') {
    return formatSkillBlock({
      name: skillNameOf(target.name),
      location: resource.path,
      // pi's block names the skill's own directory; the host always supplies it, and a path
      // without one is a reason to show the block anyway, not to hide it.
      baseDir: resource.baseDir ?? parentOf(resource.path),
      body: resource.body,
      args: restOf(target, form),
    });
  }
  return substitutePromptArgs(resource.body, buildArgs(target, form));
}

/** Drop the last path segment without importing `node:path` into the browser bundle. */
const parentOf = (p: string): string => p.replace(/[/\\][^/\\]*[/\\]?$/, '');

/** Where the caret belongs after an insertion, and the draft it sits in. */
export interface DraftInsertion {
  value: string;
  caret: number;
}

/**
 * Put an expanded block into the draft without disturbing anything around it.
 *
 * A prompt body is a paragraph, so it needs a blank line between it and the prose the human
 * already wrote — otherwise two prompts read as one run-on instruction. A single-line expansion
 * is a phrase, so a space is the right separator, and either way the human's own surrounding
 * whitespace is left alone instead of being rewritten. The block's *own* trailing whitespace goes,
 * because the separator below is what spaces the draft — pi's parity is about the substituted
 * text, and a template's trailing newline is not part of any argument.
 */
export function joinDraft(
  head: string,
  text: string,
  tail: string,
): DraftInsertion {
  const body = text.replace(/\s+$/, '');
  const gap = body.includes('\n') ? '\n\n' : ' ';
  const before = head.trim() && !/\s$/.test(head) ? gap : '';
  const after = tail.trim() && !/^\s/.test(tail) ? gap : '';
  const value = `${head}${before}${body}${after}${tail}`;
  return { value, caret: head.length + before.length + body.length };
}
