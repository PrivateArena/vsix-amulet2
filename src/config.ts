import * as vscode from 'vscode';
import type { ThinkingLevelSetting, WebviewConfig } from '../shared/protocol';

export interface PiConfig {
  binaryPath: string;
  agentDir: string;
  defaultModel: string;
  /** `disabled` (default) leaves the runtime's thinking level untouched. */
  thinkingLevel: ThinkingLevelSetting;
  autoCompact: boolean;
  autoRetry: boolean;
  /** Webview-only: render new reasoning blocks expanded. */
  expandThinking: boolean;
  extraArgs: string[];
}

const SECTION = 'pintra';

export function readConfig(): PiConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    binaryPath: cfg.get<string>('binaryPath', 'pi').trim() || 'pi',
    agentDir: cfg.get<string>('agentDir', '').trim(),
    defaultModel: cfg.get<string>('defaultModel', '').trim(),
    thinkingLevel: cfg.get<ThinkingLevelSetting>('thinkingLevel', 'disabled'),
    autoCompact: cfg.get<boolean>('autoCompact', true),
    autoRetry: cfg.get<boolean>('autoRetry', true),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    extraArgs: cfg.get<string[]>('extraArgs', []),
  };
}

/** The subset of settings the webview renders. */
export function webviewConfig(): WebviewConfig {
  const { expandThinking } = readConfig();
  return { expandThinking };
}

/** Config key behind the webview's "Uncollapse thinking" toggle. */
export const EXPAND_THINKING_KEY = `${SECTION}.expandThinking`;

/** Config key for the startup thinking level (`disabled` = leave the runtime alone). */
export const THINKING_LEVEL_KEY = `${SECTION}.thinkingLevel`;

/** Persist {@link PiConfig.expandThinking} so the preference survives reloads. */
export async function setExpandThinking(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('expandThinking', enabled, vscode.ConfigurationTarget.Global);
}

/** Config keys whose change should trigger a runtime restart. */
export const RESTART_KEYS = [
  `${SECTION}.binaryPath`,
  `${SECTION}.agentDir`,
  `${SECTION}.defaultModel`,
  `${SECTION}.extraArgs`,
];

export function affectsRestart(e: vscode.ConfigurationChangeEvent): boolean {
  return RESTART_KEYS.some((key) => e.affectsConfiguration(key));
}
