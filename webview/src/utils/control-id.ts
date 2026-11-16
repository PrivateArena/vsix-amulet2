/**
 * The identifier vocabulary of the chat UI.
 *
 * Every persistent control has one human name — the text of its hover tooltip and its
 * `aria-label` — and that name is also its DOM `id`: **Pi packages** ⇄ `id="pi-packages"`.
 * So a control can be named three ways and mean the same thing: by what the screen shows,
 * by what the user reads off a tooltip, or by the selector an agent greps for.
 *
 * Two rules keep that true:
 * - a control that exists **once per surface** carries a literal `id` written at its JSX,
 *   so `rg 'id="preferences-menu"'` lands on the component that owns it;
 * - a control that repeats (a row of a list, a card of a tool call) carries a stable
 *   **class** instead, because an `id` has to be unique in the document.
 *
 * {@link controlIdOf} is for the ids a component derives from a label it already renders —
 * menu items, mostly, where the label is the only name there is.
 */

/** Collapse a run of non-alphanumerics into one hyphen, and trim leading/trailing hyphens. */
function hyphenate(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * "Sticky approval alerts" → `sticky-approval-alerts`. Returns `''` for a name with no
 * alphanumerics (a bare icon), so a caller must not assume the result is a usable id.
 */
export function controlIdOf(name: string): string {
  return hyphenate(name);
}

/**
 * One item of a menu: `{ menuId }-{slug of the item label}`, or the item's own `id` when it
 * has one. That override is what keeps an id stable when the *label* is not — the Privacy
 * mode entry appends "(2 rules unusable)" to its text, and a name that changes shape is not
 * something a person can quote.
 */
export function menuItemId(
  menuId: string,
  item: {
    label: string;
    id?: string;
  },
): string {
  const slug = item.id?.trim() || hyphenate(item.label);
  return slug ? `${menuId}-${slug}` : menuId;
}
