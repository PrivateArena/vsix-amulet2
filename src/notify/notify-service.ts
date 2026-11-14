/**
 * Telling the human when Amulet has something for them.
 *
 * This is the only `vscode`-touching half of `src/notify/`: it reads the settings, owns the status-bar
 * entry, and hands the payloads decided in {@link run-report} / {@link approval-prompt} to the two channels —
 * VS Code's own notification (always, as a record with a route back to the chat) and the operating system's
 * notification centre ({@link system-channel}), which is the one that reaches a user sitting in another
 * window. Which dialogs are still waiting is not this module's business: {@link ApprovalLedger} owns that.
 *
 * Two triggers exist because those are the two moments Amulet knows about from the wire:
 *
 * - a run finished writing its report (`agent_end` / `agent_settled`, seen once per runtime through
 *   {@link watchRuntime});
 * - a pi extension is parked on an answer (the claiming {@link ChatBridge} calls {@link approvalRequested},
 *   and the single-answer slot of `ui-request-routing` calls {@link approvalSettled}).
 */

import * as vscode from 'vscode';
import { NOTIFY_APPROVAL_KEY, notifySettings } from '../config';
import type { Logger, PiRuntime } from '../runtime/pi-runtime';
import type { ExtensionUiRequest } from '../../shared/protocol';
import {
  approvalStatusLabel,
  needsSystemNotification,
  projectLabel,
  toastText,
  type AttentionMessage,
} from './attention';
import { ApprovalLedger } from './approval-ledger';
import {
  describeFinishedRun,
  RunWatcher,
  type FinishedRun,
} from './run-report';
import {
  describeApprovalPrompt,
  describeApprovalRequest,
} from './approval-prompt';
import {
  createSystemChannel,
  toSystemNotification,
  type SystemChannel,
} from './system-channel';

/** Button on every alert. */
const SHOW_CHAT_LABEL = 'Show Chat';

/**
 * Where a click goes: {@link PiSidebarProvider.reveal} plus composer focus, on the contributed command. A
 * dialog is shown on every surface, so the sidebar is always a route to the one that is parked.
 */
const SHOW_CHAT_COMMAND = 'amulet.focusInput';

interface NotifyService {
  readonly log: Logger;
  readonly channel: SystemChannel;
  readonly statusItem: vscode.StatusBarItem;
  readonly ledger: ApprovalLedger;
}

let service: NotifyService | undefined;

/** Runtimes already followed. Module state, not service state, so a re-init never double-watches. */
const watched = new WeakSet<PiRuntime>();

/**
 * Install the notification service for this window. Idempotent: a second call replaces the first, and the
 * runtimes already being followed keep reporting into the new one.
 */
export function initNotifications(log: Logger): vscode.Disposable {
  disposeNotifications();
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90,
  );
  statusItem.command = SHOW_CHAT_COMMAND;
  statusItem.tooltip =
    'A pi extension is parked waiting for an answer — click to open the chat';
  const current: NotifyService = {
    log,
    channel: createSystemChannel({ log: (text) => log.info(text) }),
    statusItem,
    ledger: new ApprovalLedger({
      log: (text) => log.info(text),
      render: (open) => renderApprovalCount(current, open),
    }),
  };
  service = current;
  // The counter is the one part of the feature that is not an alert, so it has to follow its setting
  // while a dialog is still parked — otherwise it keeps a stale count until the next event.
  const watchSetting = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(NOTIFY_APPROVAL_KEY)) {
      renderApprovalCount(current, current.ledger.size());
    }
  });
  return {
    dispose: () => {
      watchSetting.dispose();
      disposeNotifications();
    },
  };
}

/** Tear the service down (deactivation, or a re-init replacing the previous instance). */
export function disposeNotifications(): void {
  const current = service;
  if (!current) return;
  service = undefined;
  current.ledger.dispose();
  current.statusItem.dispose();
}

/**
 * Follow one runtime's run completions. Called from every surface's `connect()`, and a no-op after the
 * first: the watcher is installed once per runtime, so a run reports once however many chats are open.
 */
export function watchRuntime(runtime: PiRuntime): void {
  if (watched.has(runtime)) return;
  watched.add(runtime);
  const watcher = new RunWatcher();
  runtime.onEvent((event) => {
    // Read the service at event time: a re-init replaces it, and this listener outlives the swap.
    const current = service;
    if (!current) return;
    const finished = watcher.feed(event);
    if (finished) reportFinished(runtime.cwd, finished, current);
  });
  runtime.onStatus((status) => {
    if (status.phase === 'ready') return;
    const current = service;
    if (!current) return;
    // A restart (or a crash) ends the run without `agent_settled`: report what it died on, and forget the
    // dialogs that died with it — but only this runtime's, another folder may still be parked.
    const dropped = watcher.abandon();
    if (dropped) reportFinished(runtime.cwd, dropped, current);
    // Renders through the ledger's own callback.
    current.ledger.clearRuntime(runtime.cwd);
  });
}

/** Announce a finished run, when the setting allows it. */
function reportFinished(
  cwd: string,
  run: FinishedRun,
  current: NotifyService,
): void {
  if (!notifySettings().onTurnDone) return;
  const message = describeFinishedRun(run, projectLabel(cwd));
  current.log.info(
    `[notify] run finished (${run.outcome}, stop=${run.stopReason}): ${message.body}`,
  );
  deliver(message, current);
}

/**
 * Announce a dialog that is parked on a human answer, and keep it visible until somebody answers it.
 * Only the bridge that claimed the request gets here, so one dialog is one alert however many surfaces it
 * was shown on.
 */
export function approvalRequested(req: ExtensionUiRequest, cwd: string): void {
  const current = service;
  if (!current || current.ledger.has(req.id)) return;
  const prompt = describeApprovalRequest(req);
  if (!prompt) return;
  // Tracked whatever the setting says: the status-bar entry is the durable half, and turning the alert off
  // for a moment must not leave a parked dialog uncounted once it is back on.
  current.ledger.track(req.id, cwd, prompt.timeoutMs);
  if (!notifySettings().onApproval) return;
  const message = describeApprovalPrompt(prompt, projectLabel(cwd));
  current.log.info(
    `[notify] ${prompt.kind} waiting for an answer (${req.id}): ${message.body}`,
  );
  deliver(message, current);
}

/** Stop tracking a dialog: it was answered, cancelled, or its runtime went away. */
export function approvalSettled(id: string): void {
  const current = service;
  if (!current) return;
  current.ledger.settle(id);
}

function renderApprovalCount(current: NotifyService, open: number): void {
  const label = notifySettings().onApproval ? approvalStatusLabel(open) : null;
  if (!label) {
    current.statusItem.hide();
    return;
  }
  current.statusItem.text = label;
  current.statusItem.show();
}

/**
 * Send to both channels. The OS notifier is never awaited: `notify-send` takes a moment and the Windows
 * balloon script takes seconds, and a toast the human has to wait out is worse than no toast.
 */
function deliver(message: AttentionMessage, current: NotifyService): void {
  const settings = notifySettings();
  if (
    needsSystemNotification({
      enabled: settings.system,
      windowFocused: vscode.window.state.focused,
    })
  ) {
    void current.channel
      .send(toSystemNotification(message, { sticky: settings.sticky }))
      .then((ok) => {
        if (!ok)
          current.log.info('[notify] no OS channel took it; toast only.');
      })
      .catch((err: unknown) => {
        current.log.info(
          `[notify] the OS channel failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
  const text = toastText(message);
  const prompt = message.critical
    ? vscode.window.showWarningMessage(text, SHOW_CHAT_LABEL)
    : vscode.window.showInformationMessage(text, SHOW_CHAT_LABEL);
  // `Thenable`, not `Promise`: the rejection handler is the second argument of `then`.
  void prompt.then(
    (pick) => {
      if (pick === SHOW_CHAT_LABEL) {
        void vscode.commands.executeCommand(SHOW_CHAT_COMMAND);
      }
    },
    () => undefined,
  );
}

/**
 * Fire one notification through the real channels, ignoring the focus rule and the trigger settings, so
 * the user can see what their machine actually does. Backs `Amulet: Test Notification`.
 */
export async function sendTestNotification(): Promise<void> {
  const current = service;
  if (!current) return;
  const message: AttentionMessage = {
    title: 'Amulet: test notification',
    body: 'If you can see this, Amulet can reach you from another window.',
    critical: true,
  };
  const settings = notifySettings();
  // The test is the tool a user has for this exact question, so say which of the two behaviours the
  // current settings ask for: a banner that vanishes, or a critical one a server keeps until it is clicked.
  const tier = settings.sticky
    ? 'critical tier, kept until dismissed'
    : 'normal tier, expires on the server clock';
  const ok = await current.channel.send(
    toSystemNotification(message, { sticky: settings.sticky }),
  );
  const via = ok ? current.channel.describe() : 'VS Code toast only';
  const caveat = settings.system
    ? ''
    : ' · amulet.notifySystem is currently off';
  current.log.info(
    `[notify] test notification delivered via ${via} (${tier}).`,
  );
  const pick = await vscode.window.showInformationMessage(
    `Amulet notification test — delivered via ${via}, ${tier}${caveat}.`,
    SHOW_CHAT_LABEL,
  );
  if (pick === SHOW_CHAT_LABEL) {
    await vscode.commands.executeCommand(SHOW_CHAT_COMMAND);
  }
}
