import { ThinkingLevel } from '../../../shared/protocol';

export {
  FALLBACK_THINKING_LEVELS,
  THINKING_LEVEL_ORDER,
} from '../../../shared/protocol';

/**
 * Labels only — the *set* of levels always comes from the runtime
 * (`get_available_thinking_levels`), never from this file. Unknown levels fall
 * back to their raw pi name, so a newer harness stays usable.
 */
export const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Shown when the runtime has no thinking level applied, i.e. `amulet.thinkingLevel`
 * is `disabled` and nothing has been selected this session: pi, the model config
 * and the provider defaults decide.
 */
export const DISABLED_LABEL = 'Disabled';

export function thinkingLabel(level: ThinkingLevel | null): string {
  return level == null ? DISABLED_LABEL : (LEVEL_LABELS[level] ?? level);
}
