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
  /**
   * A click target: the key the server reports when the human activates the notification, and the label
   * it shows for it. Only the freedesktop channel can carry one (neither `display notification` nor a
   * balloon tip has actions), and only an expiring notification may carry one — see
   * {@link toSystemNotification}.
   */
  action?: NotifyAction;
}

/** A click action, in the server's own vocabulary. */
export interface NotifyAction {
  key: string;
  label: string;
}

/**
 * `default` is the freedesktop key for "the notification itself": clicking the banner — or the button
 * rendered for it — reports this key rather than a named action.
 */
export const CLICK_ACTION: NotifyAction = {
  key: 'default',
  label: 'Open Amulet',
};

export interface NotifyCommand {
  command: string;
  args: string[];
  /** Extra variables the channel reads. Windows passes the text this way, never through argv quoting. */
  env?: Record<string, string>;
}

/** Shown as the notification's source on the freedesktop channel. */
const APP_NAME = 'Amulet';

const NOTIFIER_TIMEOUT_MS = 20_000;

/**
 * The file descriptor `notify-send` writes the notification id to. It is the only honest delivery
 * receipt — the exit code says nothing, measured: expired, clicked and server-closed all exit 0.
 */
const ID_FD = 3;

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
 * How long a clickable banner stays. The click is caught by a process that waits for it, so a
 * notification with an action must be one the server is guaranteed to retire — this is that guarantee for
 * an alert that would otherwise take the server's own (unspecified) duration.
 */
const CLICKABLE_ALERT_EXPIRE_MS = 30_000;

/**
 * Map the UI-level weight of a message onto the notification centre's tiers and clickability.
 *
 * `critical` and "disappears on its own" cannot be asked for at once: the freedesktop convention —
 * followed by xfce4-notifyd, GNOME and mako alike, and verified against the former — is that a critical
 * notification ignores any timeout and is dismissed only by a human. So {@link sticky} chooses between the
 * two honest readings of an unanswered dialog: survive Do-Not-Disturb and stay until clicked, or behave
 * like every other application's banner. Only the approval alert is affected; a finished run is never
 * critical.
 *
 * A pinned banner is never clickable either, for the same reason as the timeout: the click has to be
 * caught by somebody who is still there when it happens, and a notification that never expires has no
 * such moment.
 */
export function toSystemNotification(
  message: {
    title: string;
    body: string;
    critical: boolean;
  },
  { sticky, clickable = false }: { sticky: boolean; clickable?: boolean },
): SystemNotification {
  const pinned = message.critical && sticky;
  const action = !pinned && clickable ? CLICK_ACTION : undefined;
  return {
    title: message.title,
    body: message.body,
    urgency: pinned ? 'critical' : 'normal',
    // A pinned alert asks for no timeout at all — on a server that does expire critical ones, the
    // default is what the user accepted by turning the tier on.
    expireMs: pinned
      ? undefined
      : message.critical
        ? APPROVAL_ALERT_EXPIRE_MS
        : action
          ? CLICKABLE_ALERT_EXPIRE_MS
          : undefined,
    action,
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
          ...(n.action
            ? ['--action', `${n.action.key}=${n.action.label}`]
            : []),
          // The id arrives on its own descriptor, so "it was posted" is known before the banner is gone.
          `--id-fd=${ID_FD}`,
          // End of options: a report or a folder name may begin with a dash, and getopt would eat it.
          '--',
          n.title,
          n.body,
        ],
      };
    case 'darwin':
      // Body and title travel as argv items, so quotes in a report cannot break the AppleScript. There is
      // no action and no tier to ask for: `display notification` always expires and cannot be clicked on.
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
  /**
   * Deliver one notification; false means no OS channel took it (the toast already did). Resolves as soon
   * as the server has posted it, not when the banner is gone.
   */
  send(
    n: SystemNotification,
    onAction?: (key: string) => void,
  ): Promise<boolean>;
  /** What the channel resolved to, for the test command and the log. */
  describe(): string;
}

/** What starting a notifier told us: delivered, refused, or simply not there. */
export interface NotifyRunResult {
  delivered: boolean;
  /** The command could not be started at all, so retrying it is pointless. */
  missing?: boolean;
}

export interface NotifyRunHooks {
  /**
   * The action key the human chose, reported when the waiting notifier exits. Only fires for a
   * notification that carried an {@link NotifyAction} and was actually activated.
   */
  onAction?(key: string): void;
}

export interface SystemChannelDeps {
  log(text: string): void;
  platform?: NodeJS.Platform;
  /** PATH lookup. `null` means the notifier is not installed here. */
  resolve?: (command: string) => string | null;
  /** Starts the command. Never rejects: a missing notifier is a result, not an exception. */
  run?: (
    command: NotifyCommand,
    hooks?: NotifyRunHooks,
  ) => Promise<NotifyRunResult>;
}

/** Give up on a notifier that keeps refusing, e.g. one too old for the options we pass. */
const MAX_REFUSALS = 3;

/**
 * Start the notifier; never rejects — a spawn failure is reported as `missing`.
 *
 * "Delivered" is decided by the **id on fd 3**, not by the exit, and it is decided as soon as the server
 * has answered. Three measured reasons: the exit code is 0 for expired, clicked *and* server-closed, so it
 * distinguishes nothing; a notifier carrying an action does not exit until the banner is gone, so waiting
 * for it would turn "posted" into "the human is done with it"; and libnotify, on a server it decides has no
 * action support, *displays* the notification and still exits 1 — which must not read as a refusal.
 *
 * There is deliberately no `timeout` on this spawn: our own kill used to look like a refusal, so three
 * legitimate clicks would have disabled the channel for the session. The bounded lifetime of a click
 * waiter comes from the expiry the notification itself asks for.
 */
export async function runNotifyCommand(
  command: NotifyCommand,
  hooks: NotifyRunHooks = {},
): Promise<NotifyRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      // One pipe per channel that carries information: stdout (the action key), stderr (ignored), and the
      // notification id on {@link ID_FD}.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...command.env },
    });
    // The host must be able to quit — or the human to reload the window — while a banner is still up.
    child.unref();
    let id = '';
    let stdout = '';
    let settled = false;
    const finish = (result: NotifyRunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // A partial read must not be mistaken for an id: wait for the line the tool writes.
    const postedId = (): number | undefined => {
      if (!/\d+\s*$/m.test(id) || !id.includes('\n')) return undefined;
      return Number.parseInt(id.trim(), 10);
    };
    child.stdio[ID_FD]?.on('data', (chunk: Buffer) => {
      id += chunk.toString();
      const numeric = postedId();
      // `0` is libnotify's "the Notify call failed" answer; anything else is a banner on screen.
      if (numeric !== undefined) finish({ delivered: numeric > 0 });
    });
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', (err) =>
      finish({
        delivered: false,
        missing: (err as NodeJS.ErrnoException)?.code !== undefined,
      }),
    );
    child.on('close', (code, signal) => {
      const key = stdout.trim();
      if (key) hooks.onAction?.(key);
      const numeric = postedId();
      // No id at all: an old notifier that does not know `--id-fd`, or one that never started. Fall back
      // to the old reading of the exit — a clean exit is then the only evidence there is.
      finish({
        delivered: numeric !== undefined ? numeric > 0 : code === 0 && !signal,
      });
    });
    // A server that never answers must not leave the promise hanging; unref'd, so it never holds the host.
    setTimeout(() => finish({ delivered: false }), NOTIFIER_TIMEOUT_MS).unref();
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
    async send(n, onAction) {
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
      const result = await run(
        { ...built, command: target },
        {
          onAction,
        },
      ).catch((err: unknown) => ({
        delivered: false,
        missing: (err as NodeJS.ErrnoException)?.code === 'ENOENT',
      }));
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
      if (target) return `${built.command} → ${target}`;
      return `${built.command} (not tried yet)`;
    },
  };
}
