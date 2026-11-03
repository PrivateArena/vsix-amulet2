import { describe, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../shared/protocol';
import {
  describeApprovalPrompt,
  describeApprovalRequest,
} from './approval-prompt';

/** A pi 1.4.0 `extension_ui_request` as it arrives on the wire. */
function request(
  extra: Partial<ExtensionUiRequest> & { method: ExtensionUiRequest['method'] },
): ExtensionUiRequest {
  return { type: 'extension_ui_request', id: 'ui-1', ...extra };
}

const GATE_TITLE =
  'pi-gate: bash — `git push origin main` [floor: external_directory]\nrule: "git *"\nsurface: path = ask';

const CEILING_TITLE =
  'pi-subagent: explore — reached its limit of 10 turns\nturns: 10/10  ·  tool calls: 8\none extension per run: "Reject" ends it now';

describe('describeApprovalRequest', () => {
  it('describes a pi-gate approval by the call it is asking about', () => {
    const prompt = describeApprovalRequest(
      request({
        method: 'select',
        title: GATE_TITLE,
        options: ['once', 'abort'],
      }),
    );
    expect(prompt).not.toBeNull();
    expect(prompt?.kind).toBe('approval');
    expect(prompt?.heading).toBe(
      'pi-gate: bash — `git push origin main` [floor: external_directory]',
    );
  });

  it('recognises a subagent budget extension as its own kind', () => {
    const prompt = describeApprovalRequest(
      request({
        method: 'select',
        title: CEILING_TITLE,
        options: ['Reject — end the run and have it report now'],
        timeout: 300_000,
      }),
    );
    expect(prompt?.kind).toBe('budget');
    expect(prompt?.timeoutMs).toBe(300_000);
  });

  it('treats an unknown modal dialog as a question, not as noise', () => {
    const prompt = describeApprovalRequest(
      request({
        method: 'confirm',
        title: 'deploy?',
        message: 'Ship to production?',
      }),
    );
    expect(prompt?.kind).toBe('question');
    expect(prompt?.heading).toBe('deploy?');
  });

  it('falls back to the dialog body when a confirm has no title', () => {
    const prompt = describeApprovalRequest(
      request({ method: 'confirm', message: 'Really delete the branch?' }),
    );
    expect(prompt?.heading).toBe('Really delete the branch?');
  });

  it('says what it is when the dialog carries no text at all', () => {
    const prompt = describeApprovalRequest(request({ method: 'input' }));
    expect(prompt?.heading).toBe('pi is asking for input');
  });

  it('never fires for the fire-and-forget methods, however chatty they are', () => {
    for (const method of [
      'notify',
      'setStatus',
      'setWidget',
      'setTitle',
    ] as const) {
      expect(
        describeApprovalRequest(request({ method, message: 'tick' })),
      ).toBeNull();
    }
  });

  it('has no expiry when the extension waits for a human forever', () => {
    // pi-gate with `promptTimeoutMs: 0` omits the key entirely.
    expect(
      describeApprovalRequest(request({ method: 'select', title: GATE_TITLE }))
        ?.timeoutMs,
    ).toBeUndefined();
    expect(
      describeApprovalRequest(
        request({ method: 'select', title: GATE_TITLE, timeout: 0 }),
      )?.timeoutMs,
    ).toBeUndefined();
    expect(
      describeApprovalRequest(
        request({ method: 'select', title: GATE_TITLE, timeout: 'nope' }),
      )?.timeoutMs,
    ).toBeUndefined();
  });

  it('drops the detail lines out of the heading', () => {
    const prompt = describeApprovalRequest(
      request({ method: 'confirm', title: GATE_TITLE }),
    );
    expect(prompt?.heading).not.toContain('surface:');
  });
});

describe('describeApprovalPrompt', () => {
  it('leads with the command, because servers clip the body', () => {
    const message = describeApprovalPrompt(
      {
        kind: 'approval',
        heading:
          'pi-gate: bash — `git push origin main` [floor: external_directory]',
      },
      'amulet',
    );
    expect(message.title).toBe('Approval needed: git push origin main');
    expect(message.body).toBe(
      'amulet · pi-gate: bash — `git push origin main` [floor: external_directory]',
    );
  });

  it('labels each kind, with or without a quotable subject', () => {
    expect(
      describeApprovalPrompt(
        { kind: 'budget', heading: 'the question' },
        'amulet',
      ).title,
    ).toBe('Subagent needs more budget');
    expect(
      describeApprovalPrompt({ kind: 'question', heading: 'x' }, 'amulet')
        .title,
    ).toBe('Answer needed');
  });

  it('is critical, because the tool call waits for nobody else', () => {
    const message = describeApprovalPrompt(
      { kind: 'approval', heading: 'pi-gate: bash' },
      'amulet',
    );
    expect(message.critical).toBe(true);
  });
});
