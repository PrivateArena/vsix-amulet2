import { useCallback } from 'react';
import { createPortal } from 'react-dom';
import { LuCornerDownLeft } from 'react-icons/lu';
import type { CommandInfo } from '../../../../../shared/protocol';
import { fuzzyHighlight } from '../../../utils/fuzzy-highlight';
import {
  highlightQuery,
  SKILL_COMMAND_PREFIX,
} from '../../../utils/slash-command';
import {
  useComposerAnchor,
  popoverStyle,
} from '../../../hooks/use-composer-anchor';
import './slash-command-menu.scss';

export interface SlashCommand extends CommandInfo {
  /** `name` with any leading slashes stripped, ready to display/insert. */
  clean: string;
  /** Skill command (`skill:<name>`) rather than a prompt or extension command. */
  isSkill: boolean;
  /** Name shown after the `/` (and after the namespace for skills). */
  label: string;
}

interface SlashCommandMenuProps {
  items: SlashCommand[];
  query: string;
  focused: number;
  onHover: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
  /** Ref to the textarea element for positioning. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * The floating command palette shown above the composer while a `/token` is
 * being typed. Purely presentational — navigation lives in `useSlashCommands`.
 * A pick hands the command back to `onSelect`, which inserts it so arguments and
 * further `/commands` can be typed before the message is sent.
 *
 * Uses a portal + fixed positioning to escape overflow:hidden containers.
 * Positions itself above the composer using `bottom` to avoid overlaps.
 */
export function CommandMenu({
  items,
  query,
  focused,
  onHover,
  onSelect,
  textareaRef,
}: SlashCommandMenuProps) {
  const composerRect = useComposerAnchor(textareaRef);

  const handleMouseDown = useCallback(
    (cmd: SlashCommand) => (e: React.MouseEvent) => {
      e.preventDefault();
      onSelect(cmd);
    },
    [onSelect],
  );

  if (items.length === 0 || !composerRect) return null;

  const menu = (
    <div
      className="cmd-menu"
      role="listbox"
      aria-label="Slash commands"
      style={
        {
          ...popoverStyle(composerRect, window.innerHeight),
          '--amulet-popover-enter-y': '7px',
        } as React.CSSProperties
      }>
      <div className="cmd-menu-list">
        {items.map((cmd, idx) => (
          <div
            key={`${cmd.source}::${cmd.clean}`}
            data-idx={idx}
            role="option"
            aria-selected={idx === focused}
            tabIndex={-1}
            style={{ '--i': idx } as React.CSSProperties}
            className={`cmd-item${idx === focused ? ' focused' : ''}`}
            onMouseDown={handleMouseDown(cmd)}
            onMouseEnter={() => onHover(idx)}>
            <span className="cmd-item-body">
              <span className="cmd-item-name">
                <span className="cmd-item-slash">/</span>
                {cmd.isSkill && (
                  <span className="cmd-item-namespace">
                    {SKILL_COMMAND_PREFIX}
                  </span>
                )}
                {
                  fuzzyHighlight(cmd.label, highlightQuery(cmd.isSkill, query))
                    .nodes
                }
              </span>
              {cmd.description && (
                <span className="cmd-item-desc">{cmd.description}</span>
              )}
            </span>
            {cmd.source && !cmd.isSkill && (
              <span className="cmd-item-source">{cmd.source}</span>
            )}
          </div>
        ))}
      </div>
      <div className="cmd-menu-footer">
        <span className="cmd-hint">
          <kbd className="cmd-kbd">↑</kbd>
          <kbd className="cmd-kbd">↓</kbd>
          Navigate
        </span>
        <span className="cmd-hint">
          <kbd className="cmd-kbd">
            <LuCornerDownLeft size={11} />
          </kbd>
          Insert
        </span>
        <span className="cmd-hint cmd-hint-end">
          <kbd className="cmd-kbd">Esc</kbd>
          Dismiss
        </span>
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
