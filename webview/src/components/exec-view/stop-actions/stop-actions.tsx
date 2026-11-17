import { useEffect, useState } from 'react';
import { LuOctagonX, LuSquarePen, LuSquareTerminal, LuBot } from 'react-icons/lu';
import { actions } from '../../../apis/actions';
import { useChatState } from '../../../contexts/chat-context';
import {
  STOP_LABELS,
  stopDialogOf,
  stopGateOf,
  stopNotePreview,
  type StopInput,
} from '../card-menu';
import { useToolStopStore, toolStop } from '../../../stores/tool-stop-store';
import { Tooltip } from '../../ui/tooltip';
import { ReasonDialog } from '../../ui/reason-dialog';
import './stop-actions.scss';

/**
 * How long to keep the *abort* control on "Aborting…" before handing it back.
 *
 * A command stop no longer needs this: the bridge answers with `toolStopResult` (or its own watchdog does), and
 * the store retires the in-flight mark on that answer. An abort has no ack at all, so its control still needs
 * a ceiling — set past the host's RPC timeout, after which a run that ignored the abort has to leave the button
 * pressable again rather than lock the card.
 */
const ABORT_ACK_BUDGET_MS = 17_000;

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
  /**
   * This card *is* a subagent run, not a command inside one. Switches the lever: a child has no process of its
   * own to signal, so the only stop short of the turn is the one its extension can perform.
   */
  run?: boolean;
}

/**
 * The ways to stop, kept together because separating them is how one gets mistaken for the other.
 *
 * **Stop this command**: the bridge signals the process pi spawned for *this* call, the call returns a failed
 * result, and the run — and, for a nested call, the subagent that made it — continues. **Stop this subagent**
 * ends the child run through pi-subagent's own lever and lets the parent read the reason and carry on. Each has
 * a sibling that asks for a reason, and the note the human types is what makes a stop useful rather than merely
 * over: without it the model reads an exit code, or an `INCOMPLETE (aborted)`, and tries the same 50-minute
 * command again.
 *
 * Last, **Abort this turn**: pi's `abort`, the run-level cancellation this card's only Stop used to be. It stays,
 * on a different icon, because sometimes the agent itself is the thing that must stop — and it stays pressable
 * while a command stop is in flight, because a stop that did not take is exactly when it is needed.
 *
 * The controls are gated on a capability, not a guess, and on one gate rather than two: the handler and the
 * render both read {@link stopGateOf}, so a control cannot look pressable while its own click refuses.
 */
export function StopActions({
  toolCallId,
  name,
  live,
  allowAbort = true,
  run = false,
}: StopActionsProps) {
  const capabilities = useChatState().bridge.capabilities;
  const inFlight = useToolStopStore((state) => state.inFlight[toolCallId]);
  const refusal = useToolStopStore((state) => state.refusals[toolCallId]);
  const [asking, setAsking] = useState(false);
  const [aborting, setAborting] = useState(false);

  // One gate, computed once: what is offered, and what a press may reach. `inFlight` is the store's answer —
  // the bridge has been asked and has not replied — and it is the same value the button paints.
  const eligibility: StopInput = {
    toolName: name,
    live,
    toolStop: capabilities?.toolStop === true,
    subagentStop: capabilities?.subagentStop === true,
    run,
  };
  const { offered, pressable, kind } = stopGateOf(eligibility, inFlight !== undefined);
  const dialog = stopDialogOf(kind);
  const refused = refusal?.kind === kind ? refusal : undefined;
  const stopping = inFlight !== undefined;

  // pi settles a stopped call itself — an error result for a command, an aborted report for a run — so the
  // in-flight mark only has to cover the round trip, and the ack clears it. An abort has no ack to wait for.
  useEffect(() => {
    if (!live) setAborting(false);
  }, [live]);
  useEffect(() => {
    if (!aborting) return;
    const timer = setTimeout(() => setAborting(false), ABORT_ACK_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [aborting]);

  const stop = (note?: string) => {
    if (!pressable) return;
    // Marks the card as waiting *before* the post: the ack can land inside the same task, and a control that
    // painted "Stopping…" only when the answer already arrived never painted it at all.
    toolStop.setInFlight(toolCallId, kind);
    if (kind === 'run') actions.stopSubagentCall(toolCallId, note);
    else actions.stopToolCall(toolCallId, note);
  };

  if (!live) return null;

  const pendingLabel =
    kind === 'run' ? STOP_LABELS.runPending : STOP_LABELS.commandPending;
  const label =
    kind === 'run' ? STOP_LABELS.run : STOP_LABELS.command;
  const reasonLabel =
    kind === 'run' ? STOP_LABELS.runWithReason : STOP_LABELS.commandWithReason;
  // A refusal is said where the human pressed: the control stays, in its own tone, and its tooltip carries the
  // bridge's sentence — the toast beside it has already gone by the time the card is read again.
  const content = stopping
    ? pendingLabel
    : refused
      ? refused.error
      : label;
  const StopIcon = kind === 'run' ? LuBot : LuSquareTerminal;

  return (
    <>
      {offered && (
        <Tooltip content={content} side="bottom" align="end">
          {/* Visible-but-not-pressable while the stop is in flight: a control that disappears on press reads as
              a broken card, and `aria-disabled` (not `disabled`) is what lets its own tooltip report "Stopping…". */}
          <button
            type="button"
            className={`exec-action exec-action-stop${
              kind === 'run' ? ' ctl-stop-run' : ' ctl-stop-command'
            }${stopping ? ' is-stopped' : ''}${refused ? ' is-refused' : ''}`}
            aria-label={stopping ? pendingLabel : label}
            aria-disabled={!pressable || undefined}
            onClick={() => stop()}>
            <StopIcon aria-hidden />
          </button>
        </Tooltip>
      )}
      {offered && (
        <Tooltip
          content={stopping ? pendingLabel : reasonLabel}
          side="bottom"
          align="end">
          <button
            type="button"
            className={`exec-action exec-action-stop ctl-stop-with-reason${
              stopping ? ' is-stopped' : ''
            }${refused ? ' is-refused' : ''}`}
            aria-label={reasonLabel}
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
          title={dialog.title}
          subtitle={dialog.subtitle}
          placeholder={dialog.placeholder}
          confirmLabel={dialog.confirm}
          // The sentence the bridge will really inject, built from the shared constant: a preview that is a
          // paraphrase is the same kind of lie as a censored insertion. Clamped exactly as the bridge clamps it.
          preview={(note) => stopNotePreview(kind, note)}
          onCancel={() => setAsking(false)}
          onConfirm={(note) => {
            setAsking(false);
            stop(note);
          }}
        />
      )}
      {allowAbort && (
        <Tooltip
          content={
            aborting ? STOP_LABELS.turnPending : STOP_LABELS.turn
          }
          side="bottom"
          align="end">
          <button
            type="button"
            className={`exec-action exec-action-stop ctl-abort-turn${
              aborting ? ' is-stopped' : ''
            }`}
            aria-label={aborting ? STOP_LABELS.turnPending : STOP_LABELS.turn}
            aria-disabled={aborting || undefined}
            onClick={() => {
              // Only a second abort is refused. A command stop that did not take is exactly when the run-level
              // control has to still work, so an in-flight command stop must not block this.
              if (aborting) return;
              setAborting(true);
              actions.abort();
            }}>
            <LuOctagonX aria-hidden />
          </button>
        </Tooltip>
      )}
    </>
  );
}
