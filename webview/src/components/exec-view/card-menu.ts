import type { BridgeOp } from '../../../../shared/bridge-protocol';
import { isShellTool } from '../../../../shared/stop-command';

/**
 * The rules behind the context-surgery menu and behind the two Stop buttons, in one pure module.
 *
 * Two surfaces offer the same three actions — the tool card's overflow button and the transcript's
 * right-click menu — and both must refuse for exactly the same reasons, or one of them advertises an
 * operation the runtime will reject. The reducer owns the badge; this decides what may be asked.
 */
export type ContextOp = 'omit' | 'replace' | 'restore';

export interface CardMenuInput {
  /** Whether this card currently reads as omitted or edited to the model. */
  hasEdit: boolean;
  /** `ChatState.streaming`: pi can only change a conversation it is not writing. */
  streaming: boolean;
  /** `ChatState.bridge.available` — an old pi, a disabled setting or a missing bundle all say false. */
  available: boolean;
  /** The op this surface already asked for on this card, if any. */
  inFlight?: BridgeOp;
}

export interface CardMenuItem {
  op: ContextOp;
  label: string;
  disabled: boolean;
  separatorBefore?: boolean;
}

/** One label per op, so the two surfaces cannot word the same action differently. */
export const CONTEXT_OP_LABELS: Record<ContextOp, string> = {
  omit: 'Omit from context',
  replace: 'Edit context content…',
  restore: 'Show it again',
};

/**
 * The sentence under the editor's title, shared by both hosts of the dialog.
 *
 * The cache half matters: a context edit changes bytes *after* the head of the prompt, so the provider
 * re-reads everything behind it. A human changing a message in the middle of a long session is being
 * charged for that, and should hear it from the dialog rather than from an invoice.
 */
export const CONTEXT_EDIT_DIALOG_SUBTITLE =
  'Replaces this tool result in every future request. The session file and the transcript keep what really happened. Editing a message in the middle costs the model a re-read of everything after it.';

/** Why nothing can be asked right now, in the sentence a tooltip shows. Undefined = go ahead. */
export function contextOpBlocker(input: CardMenuInput): string | undefined {
  if (!input.available) {
    return 'Context editing is not available in this runtime (needs pi 1.4 or newer).';
  }
  if (input.streaming) {
    return 'Wait for the run to finish — pi can only change the conversation while it is idle.';
  }
  if (input.inFlight) {
    return `Already asking the runtime to ${input.inFlight} this result.`;
  }
  return undefined;
}

/**
 * The items for one card, or `[]` when this runtime cannot honour any of them.
 *
 * Empty rather than disabled-when-unavailable on purpose: an empty list is what makes both menu hosts
 * skip the group entirely, and the transcript menu must keep falling through to VS Code's own menu when
 * it has nothing of its own to add.
 */
export function cardMenuOf(input: CardMenuInput): CardMenuItem[] {
  if (!input.available) return [];
  const blocked = contextOpBlocker(input) !== undefined;
  const items: CardMenuItem[] = [
    {
      op: 'omit',
      label: CONTEXT_OP_LABELS.omit,
      disabled: blocked,
      separatorBefore: true,
    },
    { op: 'replace', label: CONTEXT_OP_LABELS.replace, disabled: blocked },
  ];
  // Restore only makes sense on a card the model no longer reads as it was written — and it is the
  // only way back once a reload has replaced the transcript with the projected text.
  if (input.hasEdit) {
    items.push({
      op: 'restore',
      label: CONTEXT_OP_LABELS.restore,
      disabled: blocked,
    });
  }
  return items;
}

// --------------------------------------------------------------------------- stopping a command

/**
 * The two senses of "Stop", which are not the same action and must never share a label.
 *
 * **Abort this turn** is pi's `abort`: it cancels the run's signal, so the command, the turn, the subagent
 * inside it and the model's chance to read any of it all go together. That is the right thing exactly once —
 * when the human wants the agent to stop *thinking* — and the wrong thing every time the problem is one
 * command that will not return.
 *
 * **Stop this command** signals only the process pi spawned for that call, so the call ends, its result comes
 * back with the human's words at the head of it, and the run goes on: same conversation, same warm child, and
 * for a nested call the subagent itself carries on with what it learned.
 */
export const STOP_LABELS = {
  command: 'Stop this command',
  commandPending: 'Stopping…',
  commandWithReason: 'Stop this command with reason…',
  turn: 'Abort this turn',
  turnPending: 'Aborting…',
} as const;

/** What the reason dialog promises, in the human's terms and the model's. */
export const STOP_DIALOG = {
  title: 'Stop this command',
  subtitle:
    'Ends the process that command started. The run continues and the model reads your note at the head of its result — this is not "Abort this turn", which stops everything the agent is doing.',
  placeholder: 'What should the agent do instead? (optional)',
  confirm: 'Stop command',
} as const;

export interface StopInput {
  /** Only a call with a real OS process behind it can be stopped. */
  toolName: string;
  /** pi is executing this call right now — the same `live` the abort button is gated on. */
  live: boolean;
  /**
   * The loaded bridge advertised `toolStop`. Hidden rather than disabled: a button that can only ever answer
   * with a refusal is worse on a card than no button at all, and the abort control stays either way.
   */
  toolStop: boolean;
}

/** Whether the two command controls belong on this card or row at all. */
export function canStopCommand(input: StopInput): boolean {
  return input.live && input.toolStop && isShellTool(input.toolName);
}

/**
 * Whether a press of a command control should reach the runtime.
 *
 * The controls stay *visible* while a stop is in flight — a button that vanishes on press reads as a broken card
 * — but a second press must not fire: it would signal a process that is already dying and answer a call the
 * human has already stopped.
 */
export function canPressCommandStop(
  input: StopInput & { pending?: boolean },
): boolean {
  return canStopCommand(input) && !input.pending;
}
