import { useCallback } from 'react';
import {
  LuBrain,
  LuChevronDown,
  LuChevronUp,
  LuCircleSlash,
  LuPower,
} from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import {
  FALLBACK_THINKING_LEVELS,
  THINKING_LEVEL_ORDER,
  thinkingLabel,
} from '../../../constants/thinking-level';
import { useChatState } from '../../../contexts/chat-context';
import type { ThinkingLevel } from '../../../../../shared/protocol';
import { Button } from '../../ui/button';
import { Menu, MenuItem } from '../../ui/menu-item';

/**
 * Pi's canonical order, with anything the harness invents appended as-is. pi
 * returns non-contiguous lists (unmapped levels are dropped), so sorting by the
 * canonical index — not by array position — is what keeps the picker monotonic.
 */
function orderLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  const unique = [...new Set(levels)];
  const known = THINKING_LEVEL_ORDER.filter((l) => unique.includes(l));
  const extra = unique.filter((l) => !THINKING_LEVEL_ORDER.includes(l));
  return [...known, ...extra];
}

export function ReasoningSelect() {
  const { thinkingLevel: value, thinkingLevels, session } = useChatState();
  // Nothing has reached the webview from the runtime yet: we cannot claim the
  // level is disabled, only that we do not know it.
  const known = session != null || value != null;

  const raw =
    thinkingLevels.length > 0 ? thinkingLevels : FALLBACK_THINKING_LEVELS;
  // The runtime can report a level the (stale) capability list lacks — keep it,
  // and let `orderLevels` place it rather than bolting it on at the end.
  const levels = orderLevels(
    value && !raw.includes(value) ? [...raw, value] : raw,
  );

  const items: MenuItem[] = [
    // `levels` is ascending and the menu renders upward, so this lands bottom-most.
    ...(known && value == null
      ? [
          {
            label: thinkingLabel(null),
            icon: LuCircleSlash,
            onSelect: () => {},
            kind: 'toggle' as const,
            checked: true,
          },
        ]
      : []),
    ...levels.map((level) => ({
      label: thinkingLabel(level),
      icon: level === 'off' ? LuPower : LuBrain,
      onSelect: () => {
        if (level !== value) actions.setThinkingLevel(level);
      },
      kind: 'toggle' as const,
      checked: level === value,
    })),
  ].reverse();

  const currentLabel = known ? thinkingLabel(value) : '…';
  // Re-ask the runtime on open; pi offers no model-changed event, so this is the
  // cheap guarantee that the list matches the model that is actually loaded.
  const refresh = useCallback(() => actions.requestThinkingLevels(), []);

  return (
    <Menu
      items={items}
      onOpen={refresh}
      triggerIcon={known && value == null ? LuCircleSlash : LuBrain}
      label={`Thinking: ${currentLabel}`}
      side="top-left"
      align="start"
      trigger={({ ref, triggerProps, open }) => (
        <Button
          ref={ref}
          variant="trigger"
          aria-label={currentLabel}
          aria-haspopup="menu"
          startIcon={() =>
            known && value == null ? <LuCircleSlash /> : <LuBrain />
          }
          endIcon={!open ? LuChevronUp : LuChevronDown}
          title={
            !known
              ? 'Waiting for the pi runtime…'
              : value == null
                ? 'No thinking level applied — using the pi and model defaults'
                : `Thinking level: ${currentLabel}`
          }
          {...triggerProps}>
          {currentLabel}
        </Button>
      )}
    />
  );
}
