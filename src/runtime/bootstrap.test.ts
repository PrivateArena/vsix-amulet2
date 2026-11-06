import { describe, expect, it } from 'vitest';
import { buildStartupArgs } from './bootstrap';
import type { PiConfig } from '../config';

/**
 * `buildStartupArgs` decides what the child process is told about the session it opens, and the
 * runtime restarts itself for reasons the human never asked about (a setting edit, a pi update).
 * Two invariants matter for the prompt cache:
 *
 * - a resume names the session file, and
 * - a resume never pins a model, because argv beats what the session file recorded — which would
 *   move an ongoing conversation to another model and make pi drop the replayed thinking blocks.
 */
function config(overrides: Partial<PiConfig> = {}): PiConfig {
  return {
    binaryPath: 'pi',
    agentDir: '',
    defaultModel: '',
    thinkingLevel: 'disabled',
    autoCompact: true,
    autoRetry: true,
    expandThinking: false,
    privacyMode: false,
    privacyRules: [],
    contextEditing: true,
    extraArgs: [],
    ...overrides,
  };
}

describe('buildStartupArgs', () => {
  it('starts a fresh session with the configured default model', () => {
    const args = buildStartupArgs(
      config({ defaultModel: 'anthropic/claude-sonnet-5' }),
    );
    expect(args).toEqual(['--model', 'anthropic/claude-sonnet-5']);
  });

  it('names the session file when resuming', () => {
    const args = buildStartupArgs(
      config(),
      '/home/u/.pi/agent/sessions/x/one.jsonl',
    );
    expect(args).toEqual([
      '--session',
      '/home/u/.pi/agent/sessions/x/one.jsonl',
    ]);
  });

  it('does not override the model of a resumed session', () => {
    const args = buildStartupArgs(
      config({ defaultModel: 'anthropic/claude-haiku-5' }),
      '/home/u/.pi/agent/sessions/x/one.jsonl',
    );
    expect(args).not.toContain('--model');
    expect(args).toEqual([
      '--session',
      '/home/u/.pi/agent/sessions/x/one.jsonl',
    ]);
  });

  it('appends the user arguments last in both modes', () => {
    const extra = { extraArgs: ['--thinking', 'high'] };
    expect(buildStartupArgs(config(extra))).toEqual(['--thinking', 'high']);
    expect(buildStartupArgs(config(extra), '/tmp/one.jsonl')).toEqual([
      '--session',
      '/tmp/one.jsonl',
      '--thinking',
      'high',
    ]);
  });
});
