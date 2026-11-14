import { describe, expect, it, vi } from 'vitest';
import {
  buildNotifyCommand,
  createSystemChannel,
  runNotifyCommand,
  toSystemNotification,
  type NotifyCommand,
  type NotifyRunResult,
} from './system-channel';

const approval = toSystemNotification(
  {
    title: 'amulet: approval needed',
    body: 'pi-gate: bash — `git push && rm -rf /`',
    critical: true,
  },
  { sticky: false },
);

/** The same alert with `amulet.notifySticky` on. */
const pinned = toSystemNotification(
  {
    title: 'amulet: approval needed',
    body: 'pi-gate: bash — `git push && rm -rf /`',
    critical: true,
  },
  { sticky: true },
);

/** A finished run: never critical, however the sticky switch is set. */
const report = toSystemNotification(
  { title: 'amulet: report ready', body: 'the run answered', critical: false },
  { sticky: true },
);

describe('toSystemNotification', () => {
  it('lets an unanswered dialog expire, because a server never times out a critical one', () => {
    // Verified against xfce4-notifyd: with `--urgency=critical` the client's `--expire-time` is ignored
    // and the banner survives until it is clicked. So the default asks for the ordinary tier, which is
    // what "a notification, not a modal" means on every other application.
    expect(approval.urgency).toBe('normal');
    expect(approval.expireMs).toBe(60_000);
  });

  it('asks for the tier that survives Do-Not-Disturb only when the banner should be kept', () => {
    expect(pinned.urgency).toBe('critical');
    // No timeout is asked for: a kept banner is one the user accepted as persistent, and a server that
    // did honour a timeout would use its default.
    expect(pinned.expireMs).toBeUndefined();
  });

  it('never promotes a finished run, sticky or not', () => {
    expect(report.urgency).toBe('normal');
    // A report is a lead-in, so it takes the server's own duration.
    expect(report.expireMs).toBeUndefined();
  });
});

describe('buildNotifyCommand', () => {
  it('asks the freedesktop notifier, in a vocabulary it accepts', () => {
    const built = buildNotifyCommand('linux', approval);
    expect(built?.command).toBe('notify-send');
    expect(built?.args).toContain('--app-name=Amulet');
    // `notify-send` exits 1 on an urgency it does not know, so only its own three words are legal.
    expect(built?.args).toContain('--urgency=normal');
    expect(built?.args).toContain('--expire-time=60000');
    const args = built!.args;
    // Positional text only after the end-of-options marker, or getopt eats a title that starts with `-`.
    expect(args.indexOf('--')).toBeGreaterThan(-1);
    expect(args.indexOf('--')).toBeLessThan(args.indexOf(approval.title));
    expect(args.indexOf(approval.title)).toBeLessThan(
      args.indexOf(approval.body),
    );
    expect(built?.args).toContain('pi-gate: bash — `git push && rm -rf /`');
  });

  it('passes a kept banner as critical, and asks for no timeout at all', () => {
    const built = buildNotifyCommand('linux', pinned);
    expect(built?.args).toContain('--urgency=critical');
    expect(built?.args.some((a) => a.startsWith('--expire-time'))).toBe(false);
  });

  it('escapes nothing on macOS because nothing is interpolated into a script', () => {
    const built = buildNotifyCommand('darwin', approval);
    expect(built?.command).toBe('osascript');
    const script = built!.args.filter((a) =>
      a.includes('display notification'),
    );
    expect(script[0]).toContain('(item 1 of argv)');
    expect(script[0]).not.toContain('rm -rf');
    expect(built?.args.slice(-2)).toEqual([
      'pi-gate: bash — `git push && rm -rf /`',
      'amulet: approval needed',
    ]);
  });

  it('carries the Windows balloon text in the environment, not in the command line', () => {
    const built = buildNotifyCommand('win32', approval);
    expect(built?.command).toBe('powershell.exe');
    expect(built?.args.join(' ')).not.toContain('rm -rf');
    expect(built?.env?.AMULET_NOTIFY_BODY).toBe(
      'pi-gate: bash — `git push && rm -rf /`',
    );
    expect(built?.env?.AMULET_NOTIFY_TITLE).toBe('amulet: approval needed');
  });

  it('offers no channel for a platform it does not know', () => {
    expect(buildNotifyCommand('sunos', approval)).toBeNull();
  });
});

describe('createSystemChannel', () => {
  function make(
    o: {
      platform?: NodeJS.Platform;
      resolve?: (command: string) => string | null;
      run?: (command: NotifyCommand) => Promise<NotifyRunResult>;
    } = {},
  ) {
    const log = vi.fn();
    const sent: NotifyCommand[] = [];
    const channel = createSystemChannel({
      log,
      platform: o.platform ?? 'linux',
      resolve: o.resolve ?? ((_command: string) => '/usr/bin/notify-send'),
      run:
        o.run ??
        (async (command: NotifyCommand): Promise<NotifyRunResult> => {
          sent.push(command);
          return { delivered: true };
        }),
    });
    return { channel, log, sent };
  }

  const refused = vi.fn(async (_: NotifyCommand): Promise<NotifyRunResult> => ({
    delivered: false,
  }));

  it('resolves the notifier once and uses the absolute path', async () => {
    const { channel, sent } = make();
    await expect(channel.send(approval)).resolves.toBe(true);
    expect(sent[0]?.command).toBe('/usr/bin/notify-send');
  });

  it('says so and gives up when the machine has no notifier', async () => {
    const resolve = vi.fn((_command: string): string | null => null);
    const run = vi.fn(async (_: NotifyCommand): Promise<NotifyRunResult> => ({
      delivered: true,
    }));
    const { channel, log } = make({ resolve, run });
    await expect(channel.send(approval)).resolves.toBe(false);
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    // The lookup is not repeated for every finished run.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.join(' ')).toContain('notify-send');
    expect(channel.describe()).toContain('not installed');
  });

  it('disables the channel when the notifier cannot be started at all', async () => {
    // What a missing binary looks like from `spawn`, reported as a result rather than an exception.
    const run = vi.fn(async (_: NotifyCommand): Promise<NotifyRunResult> => ({
      delivered: false,
      missing: true,
    }));
    const { channel, log } = make({ run });
    await expect(channel.send(approval)).resolves.toBe(false);
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.join(' ')).toContain('disabling');
    expect(channel.describe()).toContain('not installed');
  });

  it('gives up on a notifier that keeps refusing, but not after one refusal', async () => {
    // e.g. an `notify-send` too old for the options we pass: it exits non-zero every time.
    const { channel, log } = make({ run: refused });
    await expect(channel.send(approval)).resolves.toBe(false);
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.join(' ')).toContain('did not deliver');
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.join(' ')).toContain('disabling');
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(refused).toHaveBeenCalledTimes(3);
  });

  it('forgets the refusals once something gets through', async () => {
    let delivered = false;
    const { channel } = make({
      run: async (): Promise<NotifyRunResult> => ({ delivered }),
    });
    await channel.send(approval);
    await channel.send(approval);
    delivered = true;
    await expect(channel.send(approval)).resolves.toBe(true);
    delivered = false;
    await expect(channel.send(approval)).resolves.toBe(false);
    await expect(channel.send(approval)).resolves.toBe(false);
  });

  it('starts nothing it cannot start, and reports it without an exception', async () => {
    // The real spawn path against a command that is not there — a notifier uninstalled under a
    // long-lived extension host. Must resolve, never reject.
    const result = await runNotifyCommand({
      command: '/nonexistent/amulet-notify-send',
      args: ['--', 'title', 'body'],
    });
    expect(result.delivered).toBe(false);
    expect(result.missing).toBe(true);
  });

  it('has no channel to describe on an unknown platform', async () => {
    const run = vi.fn(async (_: NotifyCommand): Promise<NotifyRunResult> => ({
      delivered: true,
    }));
    const { channel } = make({ platform: 'sunos' as NodeJS.Platform, run });
    await expect(channel.send(approval)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(channel.describe()).toContain('sunos');
  });

  it('forwards the message text untouched to the notifier', async () => {
    const { channel, sent } = make();
    await channel.send(approval);
    expect(sent[0]?.args).toContain(approval.title);
    expect(sent[0]?.args).toContain(approval.body);
  });
});
