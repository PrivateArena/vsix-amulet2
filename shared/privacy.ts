/**
 * Privacy mode: the censoring rules, and the one place they are applied.
 *
 * The rules are pure data (`amulet.privacyRules`, a VS Code setting), so covering a new secret is a
 * settings edit — never a code change. Each rule is either a literal search/replace pair or a
 * JavaScript regular expression, applied to a display string in declaration order.
 *
 * Nothing here touches the transcript's own data: the runtime's history, the session file and every
 * string sent back to pi stay untouched (see `rawSourceOf` in `webview/src/utils/md-units.ts`). The
 * rules run on the text a component is about to paint, which is also the text a copy or a screenshot
 * carries.
 */

/** What the built-in rules substitute for a user name. */
export const PRIVACY_PLACEHOLDER = 'username';

/** One rule as declared in settings. */
export interface PrivacyRule {
  /** Literal text to replace. Ignored when {@link pattern} is set. */
  search?: string;
  /** Regular-expression source in JavaScript syntax; always matched globally. */
  pattern?: string;
  /** Flags for {@link pattern}. `g` is added when missing; `y` is dropped (sticky matching would leak). */
  flags?: string;
  /**
   * Replacement text. `$1`-style group references work with {@link pattern} and are literal with
   * {@link search}, so a replacement may contain `$`.
   */
  replace: string;
  /** Optional name, so a rule that cannot compile is reported as something a human recognises. */
  label?: string;
}

/** A rule that compiled, with the expression it became. */
export interface CompiledPrivacyRule {
  /** The declaration, so the host can forward it to the webview without re-parsing settings. */
  source: PrivacyRule;
  /** Compiled with the `g` flag always on: a rule replaces every occurrence or none is expected. */
  re: RegExp;
  /** True for a literal {@link PrivacyRule.search}, whose replacement is not a template. */
  literal: boolean;
  label: string;
}

/** Why one declared rule is being ignored. */
export interface PrivacyRuleIssue {
  index: number;
  label: string;
  error: string;
}

export interface CompiledPrivacyRules {
  rules: CompiledPrivacyRule[];
  issues: PrivacyRuleIssue[];
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `g` on, `y` off — everything else the author asked for is kept. */
function globalFlags(flags: string | undefined): string {
  const cleaned = (flags ?? '').replace(/[gy]/g, '');
  return `g${cleaned}`;
}

/**
 * The rules that need no configuration: a user name is the secret in almost every path shown in a
 * chat (`/home/jang/…`, `/media/jang/home/…`), and replacing it is what makes a screenshot shareable.
 * Only a whole path segment counts, so `/media/jang-2` and `/media/jangfo` stay intact.
 */
export function builtinPrivacyRules(username: string): PrivacyRule[] {
  const user = (username ?? '').trim();
  if (user.length < 2) return [];
  return [
    {
      label: 'user name in a path',
      pattern: `(^|[/\\\\])${escapeRegExp(user)}(?=[/\\\\]|$|[^\\w.\\-])`,
      // `m` because a transcript is multi-line output: a path at the head of a line of a diff or a
      // terminal body starts a line, not the string.
      flags: 'm',
      replace: `$1${PRIVACY_PLACEHOLDER}`,
    },
  ];
}

function describeRule(rule: unknown, index: number): string {
  if (rule && typeof rule === 'object') {
    const label = (rule as { label?: unknown }).label;
    if (typeof label === 'string' && label.trim()) return label.trim();
    const search = (rule as { search?: unknown }).search;
    if (typeof search === 'string') return JSON.stringify(search);
    const pattern = (rule as { pattern?: unknown }).pattern;
    if (typeof pattern === 'string') return `/${pattern}/`;
  }
  return `rule #${index + 1}`;
}

/**
 * Turn the declared list into usable expressions, reporting rather than failing on a bad entry: one
 * typo in settings must not remove the rest of the censoring (or the chat) from the screen.
 */
export function compilePrivacyRules(input: unknown): CompiledPrivacyRules {
  const rules: CompiledPrivacyRule[] = [];
  const issues: PrivacyRuleIssue[] = [];
  if (input === undefined || input === null) return { rules, issues };
  if (!Array.isArray(input)) {
    issues.push({ index: -1, label: 'privacyRules', error: 'not a list' });
    return { rules, issues };
  }

  input.forEach((entry, index) => {
    const label = describeRule(entry, index);
    const fail = (error: string): void => {
      issues.push({ index, label, error });
    };
    if (!entry || typeof entry !== 'object') return fail('not an object');
    const rule = entry as Partial<PrivacyRule>;
    const hasSearch = typeof rule.search === 'string' && rule.search.length > 0;
    const hasPattern =
      typeof rule.pattern === 'string' && rule.pattern.length > 0;
    if (!hasSearch && !hasPattern)
      return fail('needs a "search" or a "pattern"');
    if (typeof rule.replace !== 'string')
      return fail('"replace" must be a string');

    // A declared `pattern` wins over `search`: whoever wrote a regex meant a regex. The dropped half
    // is still reported — a rule the human wrote must never do nothing without saying so.
    const literal = !hasPattern;
    if (!literal && hasSearch) {
      fail('"search" ignored because "pattern" is set');
    }
    const source: PrivacyRule = {
      ...(literal ? { search: rule.search } : { pattern: rule.pattern }),
      replace: rule.replace,
      ...(typeof rule.flags === 'string' ? { flags: rule.flags } : {}),
      ...(typeof rule.label === 'string' ? { label: rule.label } : {}),
    };
    let re: RegExp;
    try {
      re = literal
        ? new RegExp(escapeRegExp(source.search as string), 'g')
        : new RegExp(source.pattern as string, globalFlags(source.flags));
    } catch (error) {
      return fail(
        `invalid ${literal ? 'search' : 'pattern'}: ${String(error)}`,
      );
    }
    rules.push({ source, re, literal, label });
  });

  return { rules, issues };
}

/** `text` with every rule applied, in declaration order. Empty input costs nothing. */
export function redactWithRules(
  text: string,
  rules: CompiledPrivacyRule[],
): string {
  if (!text || rules.length === 0) return text;
  let out = text;
  for (const rule of rules) {
    // `g` expressions carry `lastIndex` between calls; a stale one would skip a match.
    rule.re.lastIndex = 0;
    out = rule.literal
      ? out.replace(rule.re, () => rule.source.replace)
      : out.replace(rule.re, rule.source.replace);
  }
  return out;
}

/** One-line form for a log: what was ignored, and why. */
export function describePrivacyIssue(issue: PrivacyRuleIssue): string {
  return `${issue.label}: ${issue.error}`;
}
