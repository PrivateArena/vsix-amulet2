/**
 * Slash commands in the composer.
 *
 * The interesting case is skills: the pi runtime reports one through
 * `get_commands` as `{ name: "skill:<name>", source: "skill" }` and expands a
 * message that *starts* with `/skill:<name>` into that skill's `SKILL.md` plus
 * the trailing arguments (`_expandSkillCommand`, anchored on the literal
 * `/skill:`). The colon is therefore part of the invocation, not a separator the
 * UI may re-parse: the completion token has to survive it, and the name must
 * never get a second slash. Prompt templates keep the plain `/name` form and
 * share this parsing.
 */

/** pi's namespace for skill commands; part of the name it reports and expands. */
export const SKILL_COMMAND_PREFIX = 'skill:';

/** Leading slashes stripped — pi reports bare names, but some sources do not. */
export const commandName = (name: string): string => name.replace(/^\/+/, '');

/** Whether this command name is a skill invocation (`skill:pdf-tools`). */
export const isSkillCommandName = (name: string): boolean =>
  commandName(name).toLowerCase().startsWith(SKILL_COMMAND_PREFIX);

/** `skill:pdf-tools` -> `pdf-tools`: the part the user actually recognises. */
export const skillNameOf = (name: string): string =>
  commandName(name).slice(SKILL_COMMAND_PREFIX.length);

/** Exact text that triggers the command when it leads a message. */
export const invocationOf = (name: string): string => `/${commandName(name)}`;

/**
 * Whether the `/query` being typed should surface this command. A skill also
 * matches on its bare name, because that is what a user types when they remember
 * the skill and not the namespace (`/pdf` -> `/skill:pdf-tools`).
 */
export const matchesSlashQuery = (name: string, query: string): boolean => {
  const q = query.toLowerCase();
  if (!q) return true;
  const n = commandName(name).toLowerCase();
  if (n.startsWith(SKILL_COMMAND_PREFIX)) {
    return n.includes(q) || n.slice(SKILL_COMMAND_PREFIX.length).includes(q);
  }
  return n.includes(q);
};

/**
 * Query to highlight inside an item's label. Once the namespace has been typed,
 * it renders as its own lead-in, so only the remainder is a match target.
 */
export const highlightQuery = (isSkill: boolean, query: string): string =>
  isSkill && query.toLowerCase().startsWith(SKILL_COMMAND_PREFIX)
    ? query.slice(SKILL_COMMAND_PREFIX.length)
    : query;

/** Range of the in-progress `/token` inside the composer value. */
export interface SlashTokenRange {
  start: number;
  end: number;
}

/** A `/token` at the end of the input, and the query typed inside it. */
export interface SlashTokenMatch extends SlashTokenRange {
  query: string;
}

/**
 * The slash token at the end of `value`, or null when the trailing word is not a
 * command. A skill keeps its namespace in the query, because `/skill:` is what pi
 * anchors on; a token still ends at a `/`, so a chained `/a /b` completes one name
 * at a time (see `splitPromptChain`).
 */
export function parseSlashToken(value: string): SlashTokenMatch | null {
  const m = value.match(/(?:^|\s)\/(skill:)?([^\s/]*)$/);
  if (!m) return null;
  const query = `${m[1] ?? ''}${m[2]}`;
  // The whitespace the regex matched is not part of the token.
  return { query, start: value.length - query.length - 1, end: value.length };
}
