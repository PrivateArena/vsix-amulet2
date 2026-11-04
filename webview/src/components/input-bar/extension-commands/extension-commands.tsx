import { useMemo } from 'react';
import { LuPuzzle } from 'react-icons/lu';
import { useChatState } from '../../../contexts/chat-context';
import { composer } from '../../../stores/composer-store';
import { invocationOf } from '../../../utils/slash-command';
import { Button } from '../../ui/button';
import { Flyout } from '../../ui/flyout';
import { extensionCommandList } from './extension-commands-view';
import './extension-commands.scss';

/**
 * pi's extension commands, one click away.
 *
 * A click does not execute anything: it writes `/name ` at the head of the draft, where pi
 * anchors a command, and leaves the caret there for the arguments. That is deliberate. pi
 * reports only a name and a description over `get_commands` — the argument grammar lives in
 * the extension's handler — so a sub-command tree would mean Amulet inventing one per
 * extension, and it would be wrong the moment the extension changed. Submitting the draft is
 * what runs the command, exactly as typing it does.
 *
 * With no extension loaded there is nothing to list, so the button does not appear at all.
 */
export function ExtensionCommands() {
  const commands = useChatState().commands;
  const extension = useMemo(() => extensionCommandList(commands), [commands]);
  if (extension.length === 0) return null;

  return (
    <div className="ext-commands-wrap">
      <Flyout
        side="top"
        align="start"
        minWidth={280}
        trigger={({ ref, triggerProps }) => (
          <Button
            ref={ref}
            variant="ghost"
            size="sm"
            className="ext-commands-btn"
            icon={LuPuzzle}
            aria-label={`Extension commands (${extension.length})`}
            {...triggerProps}
          />
        )}
        popoverProps={{ role: 'listbox', 'aria-label': 'Extension commands' }}>
        {({ close }) => (
          <div className="ext-commands-panel">
            <div className="ext-commands-head">Extension commands</div>
            {extension.map((cmd) => {
              const invocation = `${invocationOf(cmd.name)} `;
              return (
                <button
                  key={cmd.name}
                  type="button"
                  role="option"
                  className="ext-commands-row"
                  title={`Write ${invocation.trim()} into the message`}
                  onClick={() => {
                    close();
                    composer.prefixDraft(invocation);
                    composer.focus();
                  }}>
                  <span className="ext-commands-name">{invocation.trim()}</span>
                  <span className="ext-commands-desc">
                    {cmd.description || 'No description'}
                  </span>
                </button>
              );
            })}
            <div className="ext-commands-hint">
              Writes the command — add arguments, then Enter runs it.
            </div>
          </div>
        )}
      </Flyout>
    </div>
  );
}
