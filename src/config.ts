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

const SECTION = 'amulet';

/**
 * The pre-rebrand namespace (this extension shipped as `Pintra` up to 1.0.14). Renaming the
 * extension id (`publisher.name`) makes VS Code treat the build as a different extension, so there is
 * no settings migration to run — instead {@link readConfig} keeps reading the old keys as a fallback.
 * Read-only on purpose: every write path (the thinking-level toggle, the Settings editor) targets
 * {@link SECTION}.
 */
const LEGACY_SECTION = 'pintra';

/** Whether the user set {@link key} themselves, as opposed to it coming from the declared default. */
function isExplicitlySet(
  cfg: vscode.WorkspaceConfiguration,
  key: string,
): boolean {
  const s = cfg.inspect(key);
  return [s?.globalValue, s?.workspaceValue, s?.workspaceFolderValue].some(
    (v) => v !== undefined,
  );
}

export function readConfig(): PiConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
  /** `amulet.<key>` when the user set it, else the inherited `pintra.<key>`, else {@link fallback}. */
  const get = <T>(key: string, fallback: T): T => {
    if (isExplicitlySet(cfg, key)) return cfg.get<T>(key) as T;
    if (isExplicitlySet(legacy, key)) return legacy.get<T>(key) as T;
    return fallback;
  };
  return {
    binaryPath: get<string>('binaryPath', 'pi').trim() || 'pi',
    agentDir: get<string>('agentDir', '').trim(),
    defaultModel: get<string>('defaultModel', '').trim(),
    thinkingLevel: get<ThinkingLevelSetting>('thinkingLevel', 'disabled'),
    autoCompact: get<boolean>('autoCompact', true),
    autoRetry: get<boolean>('autoRetry', true),
    expandThinking: get<boolean>('expandThinking', false),
    extraArgs: get<string[]>('extraArgs', []),
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

/** {@link key} and, for a namespaced key, its pre-rebrand {@link LEGACY_SECTION} twin. */
export function keyWithLegacy(key: string): string[] {
  return key.startsWith(`${SECTION}.`)
    ? [key, `${LEGACY_SECTION}.${key.slice(SECTION.length + 1)}`]
    : [key];
}

/** Like {@link vscode.ConfigurationChangeEvent.affectsConfiguration}, but for both namespaces. */
export function affectsSetting(
  e: vscode.ConfigurationChangeEvent,
  key: string,
): boolean {
  return keyWithLegacy(key).some((k) => e.affectsConfiguration(k));
}

export function affectsRestart(e: vscode.ConfigurationChangeEvent): boolean {
  return RESTART_KEYS.some((key) => affectsSetting(e, key));
}
