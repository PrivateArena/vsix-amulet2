import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  builtinPrivacyRules,
  compilePrivacyRules,
  describePrivacyIssue,
  type PrivacyRule,
} from '../shared/privacy';
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
  /**
   * Webview-only: a single newline in a message paints as a line break (menu: "Line
   * breaks"). False is the strict Markdown reading, where a soft newline is whitespace.
   */
  preserveLineBreaks: boolean;
  /** Webview-only: censor configured text in the chat view (menu: "Privacy mode"). */
  privacyMode: boolean;
  /** Webview-only: the censoring rules, applied after the built-ins. */
  privacyRules: PrivacyRule[];
  /**
   * Load the context-surgery bridge into the child (`pi -e`), which is what makes Omit / Edit context
   * content / Revert possible at all. Spawn-time, so it is a restart key.
   */
  contextEditing: boolean;
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
    preserveLineBreaks: get<boolean>('preserveLineBreaks', true),
    privacyMode: get<boolean>('privacyMode', false),
    privacyRules: get<PrivacyRule[]>('privacyRules', []),
    contextEditing: get<boolean>('contextEditing', true),
    extraArgs: get<string[]>('extraArgs', []),
  };
}

/**
 * When Amulet is allowed to interrupt the user. Separate from {@link PiConfig} because none of it is
 * about the child process: it is read at delivery time, so a change takes effect on the next alert.
 */
export interface NotifySettings {
  /** Announce a run that finished writing its report. */
  onTurnDone: boolean;
  /** Announce a pi extension dialog parked waiting for an answer. */
  onApproval: boolean;
  /** Also reach the OS notification centre while this window is not focused. */
  system: boolean;
  /**
   * Keep the banner for an unanswered dialog on screen until it is dismissed. Off, that alert is an
   * ordinary expiring one — the default, because the freedesktop convention is that a `critical`
   * notification is never timed out, which reads as a notification that will not go away. The status-bar
   * counter is the record either way; a banner that expires costs nothing.
   */
  sticky: boolean;
}

export function notifySettings(): NotifySettings {
  // No {@link LEGACY_SECTION} fallback here: these keys shipped after the rename, and the declared
  // defaults in the manifest are their only other source. One lookup for all four switches.
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    onTurnDone: cfg.get<boolean>('notifyOnTurnDone', true),
    onApproval: cfg.get<boolean>('notifyOnApproval', true),
    system: cfg.get<boolean>('notifySystem', true),
    sticky: cfg.get<boolean>('notifySticky', false),
  };
}

/**
 * The user name the built-in privacy rule censors. `os.userInfo()` is the only portable source (a
 * Windows service can have neither `USER` nor `LOGNAME`), and a machine that cannot say who is
 * running gets no built-in rule rather than a crash at activation.
 *
 * Remembered for the life of the extension host: the call can go through NSS or LDAP, and the
 * settings are read again on every connect, every attached surface and every toggle echo.
 */
let cachedUserName: string | undefined;

function currentUserName(): string {
  if (cachedUserName === undefined) {
    try {
      cachedUserName = os.userInfo().username ?? '';
    } catch {
      cachedUserName = process.env.USER ?? process.env.USERNAME ?? '';
    }
  }
  return cachedUserName;
}

/** Compiled privacy payload, reused while the declared rules are the same list. */
interface PrivacyPayload {
  declared: string;
  rules: PrivacyRule[];
  issues: string[];
}

let cachedPrivacy: PrivacyPayload | undefined;

function privacyPayload(declaredRules: PrivacyRule[]): PrivacyPayload {
  const declared = JSON.stringify(declaredRules ?? []);
  if (cachedPrivacy?.declared === declared) return cachedPrivacy;
  // Compiled here so a broken rule is named in the host log rather than vanishing inside the webview.
  const { rules, issues } = compilePrivacyRules([
    ...builtinPrivacyRules(currentUserName()),
    ...declaredRules,
  ]);
  cachedPrivacy = {
    declared,
    rules: rules.map((rule) => rule.source),
    issues: issues.map(describePrivacyIssue),
  };
  return cachedPrivacy;
}

/** The subset of settings the webview renders. */
export function webviewConfig(): WebviewConfig {
  const { expandThinking, privacyMode, privacyRules, preserveLineBreaks } =
    readConfig();
  const { rules, issues } = privacyPayload(privacyRules);
  return {
    expandThinking,
    privacyMode,
    preserveLineBreaks,
    // The one notify switch the webview renders, and only to show its own menu checkmark: the tier of an
    // alert is decided host-side from {@link notifySettings} at delivery time, so this echo is a mirror of
    // a value the child process has no opinion about — which is why it stays out of `readConfig()`.
    notifySticky: notifySettings().sticky,
    privacyRules: rules,
    privacyRuleIssues: issues,
  };
}

/** Config key behind the webview's "Uncollapse thinking" toggle. */
export const EXPAND_THINKING_KEY = `${SECTION}.expandThinking`;

/** Config keys behind the "Privacy mode" toggle and its rules. */
export const PRIVACY_KEYS = [
  `${SECTION}.privacyMode`,
  `${SECTION}.privacyRules`,
];

/** Config key behind the "Line breaks" toggle. */
export const PRESERVE_LINE_BREAKS_KEY = `${SECTION}.preserveLineBreaks`;

/** Config key behind the "approval waiting" status-bar entry (see `src/notify`). */
export const NOTIFY_APPROVAL_KEY = `${SECTION}.notifyOnApproval`;

/** Config key behind the "Sticky approval alerts" toggle (`NotifySettings.sticky`). */
export const NOTIFY_STICKY_KEY = `${SECTION}.notifySticky`;

/** Config key for the startup thinking level (`disabled` = leave the runtime alone). */
export const THINKING_LEVEL_KEY = `${SECTION}.thinkingLevel`;

/** Persist {@link PiConfig.expandThinking} so the preference survives reloads. */
export async function setExpandThinking(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('expandThinking', enabled, vscode.ConfigurationTarget.Global);
}

/** Persist {@link PiConfig.privacyMode} so the preference survives reloads. */
export async function setPrivacyMode(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('privacyMode', enabled, vscode.ConfigurationTarget.Global);
}

/** Persist {@link PiConfig.preserveLineBreaks} so the preference survives reloads. */
export async function setPreserveLineBreaks(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('preserveLineBreaks', enabled, vscode.ConfigurationTarget.Global);
}

/**
 * Persist {@link NotifySettings.sticky} so the preference survives reloads. Written to `amulet.*` only,
 * like the other webview toggles, and never a restart: the tier of an alert is read when it is sent.
 */
export async function setNotifySticky(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    .update('notifySticky', enabled, vscode.ConfigurationTarget.Global);
}

/** Config keys whose change should trigger a runtime restart. */
export const RESTART_KEYS = [
  `${SECTION}.binaryPath`,
  `${SECTION}.agentDir`,
  `${SECTION}.defaultModel`,
  `${SECTION}.extraArgs`,
  // Like `extraArgs`, this one is spawn argv: the bridge is loaded by the child at startup only.
  `${SECTION}.contextEditing`,
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
