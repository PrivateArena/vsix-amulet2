import { describe, expect, it } from 'vitest';
import type { CommandInfo } from '../../../../../shared/protocol';
import { extensionCommandList } from './extension-commands-view';

const cmd = (name: string, source: string): CommandInfo => ({
  name,
  description: `${name} desc`,
  source,
});

describe('extensionCommandList', () => {
  it('keeps only what an extension registered', () => {
    const list = extensionCommandList([
      cmd('gatec', 'extension'),
      cmd('fix-tests', 'prompt'),
      cmd('skill:pdf-tools', 'skill'),
      cmd('login', 'built-in'),
    ]);
    expect(list.map((c) => c.name)).toEqual(['gatec']);
  });

  it('sorts by the bare name, so a re-push does not reshuffle the list under the cursor', () => {
    const list = extensionCommandList([
      cmd('subagentc', 'extension'),
      cmd('gatec', 'extension'),
      cmd('system-prompt', 'extension'),
    ]);
    expect(list.map((c) => c.name)).toEqual([
      'gatec',
      'subagentc',
      'system-prompt',
    ]);
  });

  it('drops a nameless entry rather than offering an empty invocation', () => {
    expect(
      extensionCommandList([cmd('', 'extension'), cmd('x', 'prompt')]),
    ).toEqual([]);
  });

  it('tolerates an empty command list, which is what a cold webview holds', () => {
    expect(extensionCommandList([])).toEqual([]);
  });
});
