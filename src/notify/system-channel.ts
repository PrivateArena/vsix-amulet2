/**
 * Reaching the human outside VS Code.
 *
 * Nothing here imports `vscode`. VS Code's own notification is visible inside the workbench and nowhere
 * else, so when the window is in another application Amulet asks the operating system instead — through a
 * spawned argv array (`shell: false`, so no report text can ever be read as a shell command), never as a
 * shell string. Every channel is optional: a machine without a notifier reports `false` and the caller
 * still has the toast, the status bar and the dialog itself.
 */

import { spawn } from 'node:child_process';
import { resolveBinaryPath } from '../runtime/bootstrap';

/**
 * How insistent the notification centre should be — the freedesktop vocabulary, which is all `notify-send`
 * accepts (it exits 1 on anything else, so a made-up tier silently disables the channel).
 */
export type NotifyUrgency = 'normal' | 'critical';

export interface SystemNotification {
  title: string;
  body: string;
  /**
   * The freedesktop tier. `critical` is the only one that survives Do-Not-Disturb — and, by the
   * convention every real server follows, the one that is never timed out. See
   * {@link toSystemNotification}: asking for both is contradictory, so the caller picks.
   */
  urgency: NotifyUrgency;
  /**
   * How long the banner asks to stay, in the server's own clock (it may clip it, or ignore it). Left
   * unset for the tiers that are never meant to expire — a timeout there is a promise the server breaks.
   */
  expireMs?: number;
}

export interface NotifyCommand {
  command: string;
  args: string[];
  /** Extra variables the channel reads. Windows passes the text this way, never through argv quoting. */
  env?: Record<string, string>;
}

/** Shown as the notification's source on the freedesktop channel. */
const APP_NAME = 'Amulet';

const NOTIFIER_TIMEOUT_MS = 20_000;

/** Windows balloon tip: text arrives through the environment, so nothing user-supplied is ever parsed. */
const WINDOWS_BALLOON_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type -AssemblyName System.Drawing;',
  '$i = New-Object System.Windows.Forms.NotifyIcon;',
  '$i.Icon = [System.Drawing.SystemIcons]::Exclamation;',
  '$i.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning;',
  '$i.BalloonTipTitle = $env:AMULET_NOTIFY_TITLE;',
  '$i.BalloonTipText = $env:AMULET_NOTIFY_BODY;',
  '$i.Visible = $true;',
  '$i.ShowBalloonTip(30000);',
  'Start-Sleep -Seconds 5;',
  '$i.Dispose()',
].join(' ');

/**
 * How long an expiring alert about an unanswered dialog asks to stay on screen. Longer than a report
 * (the run really is parked), short enough that a dialog answered from another keyboard is not a
 * permanent piece of furniture — and the durable half of this alert is the status-bar counter, not the
 * banner, so nothing is lost when the banner goes.
 */
const APPROVAL_ALERT_EXPIRE_MS = 60_000;

/**
 * Map the UI-level weight of a message onto the notification centre's tiers.
 *
 * `critical` and "disappears on its own" cannot be asked for at once: the freedesktop convention —
 * followed by xfce4-notifyd, GNOME and mako alike, and verified against the former — is that a critical
 * notification ignores any timeout and is dismissed only by a human. So {@link sticky} chooses between
 * the two honest readings of an unanswered dialog: survive Do-Not-Disturb and stay until clicked, or
 * behave like every other application's banner. Only the approval alert is affected; a finished run is
 * never critical.
 */
export function toSystemNotification(
  message: {
    title: string;
    body: string;
    critical: boolean;
  },
  { sticky }: { sticky: boolean },
): SystemNotification {
  const pinned = message.critical && sticky;
  return {
    title: message.title,
    body: message.body,
    urgency: pinned ? 'critical' : 'normal',
    // A pinned alert asks for no timeout at all — on a server that does expire critical ones, the
    // default is what the user accepted by turning the tier on.
    expireMs:
      message.critical && !pinned ? APPROVAL_ALERT_EXPIRE_MS : undefined,
  };
}

/** The notifier command for a platform, or `null` where no safe channel exists. */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  n: SystemNotification,
): NotifyCommand | null {
  switch (platform) {
    case 'linux':
    case 'freebsd':
    case 'openbsd':
    case 'netbsd':
      return {
        command: 'notify-send',
        // `low | normal | critical` are the only levels libnotify accepts — an unknown one exits 1.
        args: [
          `--app-name=${APP_NAME}`,
          `--urgency=${n.urgency}`,
          ...(n.expireMs === undefined ? [] : [`--expire-time=${n.expireMs}`]),
          // End of options: a report or a folder name may begin with a dash, and getopt would eat it.
          '--',
          n.title,
          n.body,
        ],
      };
    case 'darwin':
      // Body and title travel as argv items, so quotes in a report cannot break the AppleScript.
      return {
        command: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 1 of argv) with title (item 2 of argv)',
          '-e',
          'end run',
          n.body,
          n.title,
        ],
      };
    case 'win32':
      return {
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          WINDOWS_BALLOON_SCRIPT,
        ],
        env: { AMULET_NOTIFY_TITLE: n.title, AMULET_NOTIFY_BODY: n.body },
      };
    default:
      return null;
  }
}

export interface SystemChannel {
  /** Deliver one notification; false means no OS channel took it (the toast already did). */
  send(n: SystemNotification): Promise<boolean>;
  /** What the channel resolved to, for the test command and the log. */
  describe(): string;
}

/** What starting a notifier told us: delivered, refused, or simply not there. */
export interface NotifyRunResult {
  delivered: boolean;
  /** The command could not be started at all, so retrying it is pointless. */
  missing?: boolean;
}

export interface SystemChannelDeps {
  log(text: string): void;
  platform?: NodeJS.Platform;
  /** PATH lookup. `null` means the notifier is not installed here. */
  resolve?: (command: string) => string | null;
  /** Starts the command. Never rejects: a missing notifier is a result, not an exception. */
  run?: (command: NotifyCommand) => Promise<NotifyRunResult>;
}

/** Give up on a notifier that keeps refusing, e.g. one too old for the options we pass. */
const MAX_REFUSALS = 3;

/** Starts the command; never rejects — a spawn failure is reported as `missing`. */
export async function runNotifyCommand(
  command: NotifyCommand,
): Promise<NotifyRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: NOTIFIER_TIMEOUT_MS,
      env: { ...process.env, ...command.env },
    });
    child.on('error', (err) =>
      resolve({
        delivered: false,
        missing: (err as NodeJS.ErrnoException)?.code !== undefined,
      }),
    );
    // A notifier killed by its own timeout exits with no code, which is a refusal, not a delivery.
    child.on('close', (code, signal) =>
      resolve({ delivered: code === 0 && !signal }),
    );
  });
}

/**
 * Build the OS channel. One instance per extension host: the first missing notifier disables further
 * attempts, so a machine without `notify-send` does not spawn one per finished run.
 */
export function createSystemChannel(deps: SystemChannelDeps): SystemChannel {
  const platform = deps.platform ?? process.platform;
  const resolve =
    deps.resolve ??
    ((command: string) => {
      const found = resolveBinaryPath(command);
      return found.resolved ? found.command : null;
    });
  const run = deps.run ?? runNotifyCommand;
  /** Resolved notifier path, or `null` once the channel is known to be absent. */
  let target: string | null | undefined;
  /** Consecutive refusals, so an incompatible notifier is not re-run for every alert. */
  let refusals = 0;

  return {
    async send(n) {
      const built = buildNotifyCommand(platform, n);
      if (!built) return false;
      if (target === null) return false;
      if (target === undefined) {
        target = resolve(built.command);
        if (!target) {
          deps.log(
            `[notify] no "${built.command}" on PATH — notifications stay inside VS Code.`,
          );
          return false;
        }
      }
      // A notifier never gets to throw at the caller: the toast has already gone out, and an OS channel
      // that misbehaves must degrade to the log, not to an unhandled rejection in the host.
      const result = await run({ ...built, command: target }).catch(
        (err: unknown) => ({
          delivered: false,
          missing: (err as NodeJS.ErrnoException)?.code === 'ENOENT',
        }),
      );
      if (result.delivered) {
        refusals = 0;
        return true;
      }
      if (result.missing) {
        target = null;
        deps.log(
          `[notify] ${built.command} could not be started — disabling the OS channel.`,
        );
      } else if (++refusals >= MAX_REFUSALS) {
        target = null;
        deps.log(
          `[notify] ${built.command} refused ${MAX_REFUSALS} notifications in a row — disabling the OS channel.`,
        );
      } else {
        deps.log(`[notify] ${target} did not deliver the notification.`);
      }
      return false;
    },
    describe() {
      const built = buildNotifyCommand(platform, {
        title: '',
        body: '',
        urgency: 'normal',
      });
      if (!built) return `no OS notification channel for ${platform}`;
      if (target === null) return `${built.command} is not installed`;
      if (target) return target;
      return `${built.command} (not tried yet)`;
    },
  };
}
