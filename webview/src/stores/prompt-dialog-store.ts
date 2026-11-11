import { create } from 'zustand';
import type { HostMessage, PromptResource } from '../../../shared/protocol';
import { actions } from '../apis/actions';
import { composer, useComposerStore } from './composer-store';
import {
  expandedTextOf,
  initialFormOf,
  promptTargetOf,
  type LeadingPromptCommand,
  type PromptField,
  type PromptForm,
  type PromptTarget,
} from '../utils/prompt-insert';

/**
 * The prompt dialog: one prompt template or skill, its arguments, and an Insert button.
 *
 * It is a form over a file, not a run. Nothing is sent here — the expanded text lands in the
 * composer, so the human still decides when the prompt goes out and can edit it first, and a
 * second prompt can be inserted into the same draft. The body itself is asked for on open and
 * never pushed: a runtime reports dozens of templates, and only the one being edited matters.
 */
interface PromptDialogState {
  /** What the dialog is showing, or null while it is closed. */
  target: PromptTarget | null;
  /** The file behind `target`, or null while it is on its way / unreadable. */
  resource: PromptResource | null;
  /** Id of the read this dialog is waiting for, or null once answered. */
  requestId: number | null;
  /** Why there is no body, in the host's words. */
  error: string | null;
  /** Why the last Insert did nothing, or null. */
  insertError: string | null;
  /** The argument values, in pi's own positions. */
  form: PromptForm;
  /** The block the last Insert produced: Enter on that text again is not a new command. */
  lastInserted: string | null;
  open: (target: PromptTarget) => void;
  close: () => void;
  /** Fold in one read; an answer for a dialog that moved on is dropped. */
  acceptResource: (
    message: Extract<HostMessage, { type: 'promptResource' }>,
  ) => void;
  setField: (field: PromptField, value: string) => void;
  /** Hand the expanded text to the composer and close. */
  insert: () => void;
}

const EMPTY_FORM: PromptForm = { args: [], rest: '', restInitial: '' };

/** Ids only ever compare to themselves, so a monotonic counter is enough. */
let requestSeq = 0;

export const usePromptDialogStore = create<PromptDialogState>((set, get) => ({
  target: null,
  resource: null,
  requestId: null,
  error: null,
  insertError: null,
  form: EMPTY_FORM,
  lastInserted: null,

  open: (target) => {
    const requestId = ++requestSeq;
    set({
      target,
      resource: null,
      error: null,
      insertError: null,
      requestId,
      form: EMPTY_FORM,
      // A fresh question supersedes the last answer: only the text this dialog itself put in
      // the draft is exempt from being treated as a command again.
      lastInserted: null,
    });
    actions.requestPromptResource(target.name, requestId);
  },

  close: () =>
    set({
      target: null,
      resource: null,
      requestId: null,
      error: null,
      insertError: null,
      form: EMPTY_FORM,
    }),

  acceptResource: (message) => {
    const { target, requestId } = get();
    // An answer that is not the one this dialog asked for belongs to a closed dialog, or to a
    // command the human picked after it — either way it must not paint this form.
    if (!target || requestId === null || requestId !== message.requestId)
      return;
    set({
      requestId: null,
      resource: message.resource,
      error: message.resource
        ? null
        : (message.error ?? 'The host could not read that prompt file.'),
      // The typed arguments only know which box they belong to once the placeholders do.
      form: message.resource
        ? initialFormOf(target, message.resource)
        : EMPTY_FORM,
    });
  },

  setField: (field, value) =>
    set((state) => {
      if (field.kind === 'rest')
        return { form: { ...state.form, rest: value } };
      const args = [...state.form.args];
      args[field.position] = value;
      return { form: { ...state.form, args } };
    }),

  insert: () => {
    const { target, resource, form } = get();
    if (!target || !resource) return;
    if (useComposerStore.getState().api === null) {
      // The draft is gone — a restart or a crash recovery unmounted the composer, and queueing
      // the block would drop it into whatever draft appears next, or into nothing.
      set({
        insertError:
          'The composer is not on screen (the runtime is restarting), so there is nothing to insert into. Try again once it is ready.',
      });
      return;
    }
    const text = expandedTextOf(target, resource, form);
    composer.insertBlock(text, target.range);
    set({ lastInserted: text });
    get().close();
  },
}));

/** Module-level facade, so the composer can open the dialog without subscribing to it. */
export const promptDialog = {
  /** Open the dialog for one invocation of a template or skill, in the given draft range. */
  openCommand: (
    command: LeadingPromptCommand,
    range: { start: number; end: number },
  ): void =>
    usePromptDialogStore.getState().open(promptTargetOf(command, range)),
  close: (): void => usePromptDialogStore.getState().close(),
  /**
   * Whether `text` is what this dialog was opened with, or what its last Insert produced.
   *
   * That makes the interception in `composer.submit` safe twice over: a draft the human insists on
   * sending after a failed read still goes out as a command, and an expansion whose body happens
   * to start with `/name` is never mistaken for another command — pi never re-expands its own output.
   */
  handles: (text: string): boolean => {
    const { target, lastInserted } = usePromptDialogStore.getState();
    const draft = text.trim();
    if (lastInserted !== null && lastInserted.trim() === draft) return true;
    return target !== null && target.invocationText.trim() === draft;
  },
};
