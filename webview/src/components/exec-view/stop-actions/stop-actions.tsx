import { useEffect, useState } from 'react';
import { LuOctagonX, LuSquarePen, LuSquareTerminal } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import {
  clampStopNote,
  stopNoteText,
} from '../../../../../shared/stop-command';
import { Tooltip } from '../../ui/tooltip';
import { ReasonDialog } from '../../ui/reason-dialog';
import {
  STOP_DIALOG,
  STOP_LABELS,
  canPressCommandStop,
  canStopCommand,
} from '../card-menu';
import './stop-actions.scss';

/**
 * How long to keep the command controls on "Stopping…" before handing them back.
 *
 * Nothing retires this state from the child, by design: the stopped command's own result — carrying the human's
 * note — is the confirmation, and it arrives on the transcript wire that already exists. So this is a re-aim
 * delay, set past the host's 15 s ack watchdog, after which a refusal (which the human also gets as a VS Code
 * toast) no longer leaves them staring at a control nothing will answer.
 */
const STOP_ACK_BUDGET_MS = 17_000;

export interface StopActionsProps {
  /** The call to stop — the same id the bridge addresses, and the id the card is marked with. */
  toolCallId: string;
  /** Only a shell call has a process, which is what decides the command controls. */
  name: string;
  /** pi is executing this call now — the same gate the abort control has always had. */
  live: boolean;
  /**
   * Whether this surface may abort the run. A nested row of a subagent does not own it: pressing the control on
   * the outer card is how a whole subagent is stopped, and one that stopped the turn from inside a row would
   * look like a way to stop the one command it shows.
   */
  allowAbort?: boolean;
}

/**
 * The two ways to stop, kept together because separating them is how one gets mistaken for the other.
 *
 * On the left, **Stop this command**: the bridge signals the process pi spawned for *this* call, the call returns
 * a failed result, and the run — and, for a nested call, the subagent that made it — continues. Its sibling asks
 * for a reason, and the note the human types is what makes a stop useful rather than merely over: without it the
 * model reads an exit code and tries the same 50-minute command again.
 *
 * On the right, **Abort this turn**: pi's `abort`, the run-level cancellation this card's only Stop used to be.
 * It stays, on a different icon, because sometimes the agent itself is the thing that must stop — and it stays
 * pressable while a command stop is in flight, because a stop that did not take is exactly when it is needed.
 *
 * The controls are gated on a capability, not a guess: they appear only when the loaded bridge advertised
 * `toolStop`, so a runtime without it shows exactly what it showed before this existed.
 */
export function StopActions({
  toolCallId,
  name,
  live,
  allowAbort = true,
}: StopActionsProps) {
  const toolStop = useChatState().bridge.capabilities?.toolStop === true;
  const [pending, setPending] = useState<'command' | 'turn' | undefined>();
  const [asking, setAsking] = useState(false);

  // pi settles the call itself — a stopped command comes back as an error result, an aborted run as an aborted
  // tool — so `pending` only has to keep a control from looking pressable in the meantime.
  useEffect(() => {
    if (!live) setPending(undefined);
  }, [live]);
  useEffect(() => {
    if (pending === undefined) return;
    const timer = setTimeout(() => setPending(undefined), STOP_ACK_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const stopCommand = (note?: string) => {
    if (!canPressCommandStop({ toolName: name, live, toolStop, pending: true }))
      return;
    setPending('command');
    actions.stopToolCall(toolCallId, note);
  };

  if (!live) return null;

  const eligibility = { toolName: name, live, toolStop };
  const offered = canStopCommand(eligibility);
  const stopping = pending === 'command';
  const pressable = canPressCommandStop({ ...eligibility, pending: stopping });
  const aborting = pending === 'turn';

  return (
    <>
      {offered && (
        <Tooltip
          content={stopping ? STOP_LABELS.commandPending : STOP_LABELS.command}
          side="bottom"
          align="end">
          {/* Visible-but-not-pressable while the stop is in flight: a control that disappears on press reads as
              a broken card, and `aria-disabled` (not `disabled`) is what lets its own tooltip report "Stopping…". */}
          <button
            type="button"
            className={`exec-action exec-action-stop${stopping ? ' is-stopped' : ''}`}
            aria-label={
              stopping ? STOP_LABELS.commandPending : STOP_LABELS.command
            }
            aria-disabled={stopping || undefined}
            onClick={() => stopCommand()}>
            <LuSquareTerminal aria-hidden />
          </button>
        </Tooltip>
      )}
      {offered && (
        <Tooltip
          content={STOP_LABELS.commandWithReason}
          side="bottom"
          align="end">
          <button
            type="button"
            className={`exec-action exec-action-stop${stopping ? ' is-stopped' : ''}`}
            aria-label={STOP_LABELS.commandWithReason}
            aria-disabled={!pressable || undefined}
            onClick={() => {
              if (!pressable) return;
              setAsking(true);
            }}>
            <LuSquarePen aria-hidden />
          </button>
        </Tooltip>
      )}
      {asking && (
        <ReasonDialog
          title={STOP_DIALOG.title}
          subtitle={STOP_DIALOG.subtitle}
          placeholder={STOP_DIALOG.placeholder}
          confirmLabel={STOP_DIALOG.confirm}
          // The sentence the bridge will really inject, built from the shared constant: a preview that is a
          // paraphrase is the same kind of lie as a censored insertion.
          // Clamped exactly as the bridge clamps it: a preview longer than what will be sent is a lie.
          preview={(note) => stopNoteText(clampStopNote(note))}
          onCancel={() => setAsking(false)}
          onConfirm={(note) => {
            setAsking(false);
            stopCommand(note);
          }}
        />
      )}
      {allowAbort && (
        <Tooltip
          content={aborting ? STOP_LABELS.turnPending : STOP_LABELS.turn}
          side="bottom"
          align="end">
          <button
            type="button"
            className={`exec-action exec-action-stop${aborting ? ' is-stopped' : ''}`}
            aria-label={aborting ? STOP_LABELS.turnPending : STOP_LABELS.turn}
            aria-disabled={aborting || undefined}
            onClick={() => {
              // Only a second abort is refused. A command stop that did not take is exactly when the run-level
              // control has to still work, so `pending === 'command'` must not block this.
              if (aborting) return;
              setPending('turn');
              actions.abort();
            }}>
            <LuOctagonX aria-hidden />
          </button>
        </Tooltip>
      )}
    </>
  );
}
