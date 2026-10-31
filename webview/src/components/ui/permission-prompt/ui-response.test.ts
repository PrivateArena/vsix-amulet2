import { describe, expect, it } from 'vitest';
import {
  MODAL_UI_METHODS,
  type ExtensionUiRequest,
} from '../../../../../shared/protocol';
import {
  buildUiResponse,
  dialogDraft,
  dialogMessage,
  dialogOptions,
  dialogTitle,
} from './ui-response';

const req = (
  method: string,
  extra: Record<string, unknown> = {},
): ExtensionUiRequest =>
  ({
    type: 'extension_ui_request',
    id: 'r1',
    method,
    ...extra,
  }) as ExtensionUiRequest;

describe('buildUiResponse — pi RPC reply shapes', () => {
  // pi's RPC front-end (dist/modes/rpc/rpc-mode.js) reads `value` for select/input/editor,
  // `confirmed` for confirm, and treats `cancelled: true` as "no answer" (=> gate deny).
  it('answers select with the chosen option under `value`', () => {
    expect(
      buildUiResponse(req('select'), { kind: 'value', value: 'Allow once' }),
    ).toEqual({
      type: 'extension_ui_response',
      id: 'r1',
      value: 'Allow once',
    });
  });

  it('answers confirm with `confirmed` and never mixes in `value`', () => {
    const reply = buildUiResponse(req('confirm'), {
      kind: 'confirmed',
      confirmed: false,
    });
    expect(reply).toEqual({
      type: 'extension_ui_response',
      id: 'r1',
      confirmed: false,
    });
    expect(reply).not.toHaveProperty('value');
  });

  it('answers input and editor with the typed text, empty string included', () => {
    for (const method of ['input', 'editor']) {
      expect(
        buildUiResponse(req(method), { kind: 'value', value: '' }),
      ).toEqual({ type: 'extension_ui_response', id: 'r1', value: '' });
    }
  });

  it('reports Escape as `cancelled` for every method, and never as an answer', () => {
    const reply = buildUiResponse(req('select'), { kind: 'cancelled' });
    expect(reply).toEqual({
      type: 'extension_ui_response',
      id: 'r1',
      cancelled: true,
    });
    expect(reply).not.toHaveProperty('value');
    expect(reply).not.toHaveProperty('confirmed');
  });

  it('echoes the request id so pi can correlate the pending dialog', () => {
    const built = buildUiResponse(req('select'), { kind: 'cancelled' });
    expect(built.id).toBe('r1');
  });
});

describe('dialog text helpers', () => {
  it('keeps a multi-line gate title verbatim (rule + command must stay readable)', () => {
    const title =
      'pi-gate: bash — `git push` [floor: external_directory]\nrule: "git *" \nsurface: path = ask';
    expect(dialogTitle(req('select', { title }))).toBe(title);
  });

  it('falls back to a method-specific title when the extension sends none', () => {
    expect(dialogTitle(req('select'))).toBe('Choose an option');
    expect(dialogTitle(req('confirm'))).toBe('Please confirm');
    expect(dialogTitle(req('editor'))).toBe('Edit the text');
  });

  it('reads confirm body text, input placeholder and editor prefill from the right fields', () => {
    expect(dialogMessage(req('confirm', { message: 'Delete it?' }))).toBe(
      'Delete it?',
    );
    expect(dialogDraft(req('input', { placeholder: 'note' }))).toBe('note');
    expect(dialogDraft(req('editor', { prefill: 'a\nb' }))).toBe('a\nb');
  });
});

describe('dialogOptions', () => {
  it('maps plain string options to themselves (how pi-gate sends its choices)', () => {
    const options = dialogOptions(
      req('select', { options: ['Allow once', 'Abort'] }),
    );
    expect(options).toEqual([
      { label: 'Allow once', value: 'Allow once' },
      { label: 'Abort', value: 'Abort' },
    ]);
  });

  it('keeps object option labels and their underlying values', () => {
    const options = dialogOptions(
      req('select', { options: [{ label: 'Yes', value: 'y' }] }),
    );
    expect(options).toEqual([{ label: 'Yes', value: 'y' }]);
  });

  it('tolerates a missing or non-array options field', () => {
    expect(dialogOptions(req('select'))).toEqual([]);
    expect(dialogOptions(req('select', { options: 'nope' }))).toEqual([]);
  });
});

describe('MODAL_UI_METHODS', () => {
  it('lists the four dialog methods, which are the ones the host must route to exactly one surface', () => {
    expect([...MODAL_UI_METHODS].sort()).toEqual(
      ['confirm', 'editor', 'input', 'select'].sort(),
    );
  });
});
