/**
 * pi's prompt-template and skill expansion, mirrored on this side of the wire.
 *
 * A prompt template is a markdown file, and `get_commands` reports where it lives
 * (`sourceInfo.path`) but never what is inside it — argument hints belong to pi's TUI
 * (`prompt-templates.js:119`) and never cross the RPC boundary. So Amulet reads the same
 * file pi reads and expands it locally, which is what lets one draft carry several
 * prompts: the expanded text is plain prose, and pi's expander is anchored at `^` of the
 * *message*, so it can never reach a second `/name` in text it was handed (the whole rest
 * of the message would otherwise become the first command's arguments).
 *
 * These functions are copies of pi 1.5.0 behaviour, not reinterpretations:
 * - `substituteArgs` / `parseCommandArgs` — `dist/core/prompt-templates.js:11-85`
 * - `expandPromptTemplate` command split — same file, `:252-266`
 * - skill block — `dist/core/agent-session.js:1745-1765` (`_expandSkillCommand`)
 * - frontmatter body — `dist/utils/frontmatter.js` (`stripFrontmatter`)
 * Any divergence is a bug: the text inserted into the composer must be byte-identical to
 * what pi would have sent, or the preview lies about the token cost.
 */

/** Fresh pattern per use — a shared `/g` regex carries `lastIndex` between calls. */
const substitutionPattern = () =>
  /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

/**
 * Split a command's argument string the way pi does: shell-like, `"` and `'` both toggle
 * quoting, quotes are stripped, whitespace separates, and no backslash escapes exist.
 * An unterminated quote swallows the rest of the string into the last token.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  // Tracks whether a token has started, so quoted empty strings ("" or '') are kept.
  let hasToken = false;
  let inQuote: '"' | "'" | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/** `pi`'s `/name args` split: the name is the first token, the arguments are the rest verbatim. */
const COMMAND_INVOCATION = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

/**
 * Turn draft text into the invocation pi would have run, or null when it is not one.
 * Mirrors `expandPromptTemplate`'s anchor: only a message that *starts* with `/name` is
 * ever a command, and everything after that first space is its argument string.
 */
export function parsePromptInvocation(
  text: string,
): { name: string; argsString: string } | null {
  if (!text.startsWith('/')) return null;
  const match = COMMAND_INVOCATION.exec(text);
  if (!match) return null;
  return { name: match[1] as string, argsString: match[2] ?? '' };
}

/** What a template asks for, derived from the placeholders it actually contains. */
export interface TemplateArgumentShape {
  /** Highest positional index referenced; 0 when the template takes no positional argument. */
  positional: number;
  /** Whether the template reads the whole argument list (`$@`, `$ARGUMENTS`, `${@:N…}`). */
  usesRest: boolean;
  /** Per-position default, from `${N:-fallback}` — the field's placeholder text. */
  defaults: Record<number, string>;
}

/**
 * Walk the template with the substitution pattern itself, so the shape cannot drift from
 * what `substitutePromptArgs` will do with it.
 */
export function analysePromptTemplate(content: string): TemplateArgumentShape {
  const shape: TemplateArgumentShape = {
    positional: 0,
    usesRest: false,
    defaults: {},
  };
  const need = (index: number) => {
    if (index > shape.positional) shape.positional = index;
  };
  for (const match of content.matchAll(substitutionPattern())) {
    const [, defaultTarget, defaultValue, sliceStart, sliceLength, simple] =
      match;
    if (defaultTarget) {
      if (defaultTarget === '@' || defaultTarget === 'ARGUMENTS') {
        shape.usesRest = true;
        continue;
      }
      // A positional default is still a positional need, however many list placeholders the
      // same template reads — `$ARGUMENTS ${4:-x}` asks for four arguments.
      const index = Number.parseInt(defaultTarget, 10);
      need(index);
      if (defaultValue) shape.defaults[index] = defaultValue;
      continue;
    }
    if (sliceStart) {
      shape.usesRest = true;
      // pi clamps position 0 to 1, so `${@:0}` needs one argument; `${@:N:L}` needs N+L-1.
      const start = Math.max(Number.parseInt(sliceStart, 10), 1);
      need(sliceLength ? start + Number.parseInt(sliceLength, 10) - 1 : start);
      continue;
    }
    if (simple === 'ARGUMENTS' || simple === '@') {
      shape.usesRest = true;
      continue;
    }
    need(Number.parseInt(simple as string, 10));
  }
  return shape;
}

/**
 * `substituteArgs`, pi's own copy: one pass over the *template*, so a value containing
 * `$1` or `$@` is never substituted again. A positional argument that is missing is an
 * empty string, and a default fires on any falsy value — so an argument the human left
 * blank falls back to `${N:-default}` exactly as an omitted one would on the command line.
 */
export function substitutePromptArgs(content: string, args: string[]): string {
  const allArgs = args.join(' ');
  return content.replace(
    substitutionPattern(),
    (
      _match: string,
      defaultTarget?: string,
      defaultValue?: string,
      sliceStart?: string,
      sliceLength?: string,
      simple?: string,
    ) => {
      if (defaultTarget) {
        const value =
          defaultTarget === '@' || defaultTarget === 'ARGUMENTS'
            ? allArgs
            : args[Number.parseInt(defaultTarget, 10) - 1];
        return value ? value : (defaultValue ?? '');
      }
      if (sliceStart) {
        const start = Math.max(Number.parseInt(sliceStart, 10) - 1, 0);
        if (sliceLength) {
          return args
            .slice(start, start + Number.parseInt(sliceLength, 10))
            .join(' ');
        }
        return args.slice(start).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[Number.parseInt(simple as string, 10) - 1] ?? '';
    },
  );
}

/**
 * A skill's expanded form, byte for byte: pi replaces `/skill:name args` with this block,
 * so inserting it is the same request as invoking the command — including the sentence
 * that tells the model which directory its relative references resolve against.
 */
export function formatSkillBlock(skill: {
  name: string;
  location: string;
  baseDir: string;
  body: string;
  args: string;
}): string {
  const block = `<skill name="${skill.name}" location="${skill.location}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
  return skill.args ? `${block}\n\n${skill.args}` : block;
}

/**
 * A prompt or skill file's markdown body, with pi's frontmatter handling: newline
 * normalisation, BOM removal, `---` block dropped, result trimmed.
 */
export function stripTemplateFrontmatter(content: string): string {
  return extractFrontmatterBlock(content).body;
}

/**
 * One scalar frontmatter value (`description`, `argument-hint`) read without a YAML parser.
 * Deliberately narrow: the two keys pi reads are plain strings, and everything else in the
 * file is none of this client's business.
 */
export function readTemplateFrontmatter(
  content: string,
  key: string,
): string | undefined {
  const { yaml } = extractFrontmatterBlock(content);
  if (!yaml) return undefined;
  for (const line of yaml.split('\n')) {
    const match = /^\s*([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (!match || match[1]?.trim() !== key) continue;
    const value = (match[2] ?? '').trim();
    const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
    const text = quoted ? (quoted[1] as string) : value;
    return text || undefined;
  }
  return undefined;
}

/** `---` block plus body, following `extractFrontmatter` (`utils/frontmatter.js:4-25`). */
function extractFrontmatterBlock(content: string): {
  yaml: string | null;
  body: string;
} {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  // No `---` fence means no frontmatter at all, and pi keeps the *whole* file as the body,
  // untrimmed: it trims only in the branch where it actually cut a block out.
  if (!normalized.startsWith('---')) return { yaml: null, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { yaml: null, body: normalized };
  return {
    yaml: normalized.slice(4, endIndex),
    body: normalized.slice(endIndex + 4).trim(),
  };
}

/**
 * Fold a multi-line field into one line, because an argument is prose the model reads
 * inline: a pasted stack trace or list would otherwise break the sentence the template
 * wraps it in. Line breaks become single spaces; runs of spaces collapse; the body of the
 * template keeps its own newlines untouched.
 */
export function mergeToSingleLine(text: string): string {
  return text
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
