import type { CommandInfo } from '../../../../../shared/protocol';
import { commandName } from '../../../utils/slash-command';

/**
 * The commands worth putting on a button: the ones a pi extension registered.
 *
 * Prompt templates and skills are prose the model consumes and the `/` menu already
 * completes, so listing them here would be noise. Extension commands are the ones that
 * execute on their own and report back through a dialog, which is what a click should do.
 */
export function extensionCommandList(commands: CommandInfo[]): CommandInfo[] {
  return commands
    .filter((c) => c.source === 'extension' && !!commandName(c.name))
    .sort((a, b) =>
      commandName(a.name).localeCompare(commandName(b.name), undefined, {
        sensitivity: 'base',
      }),
    );
}
