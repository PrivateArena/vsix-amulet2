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

  it('asks for the click action, and for the notification id on its own descriptor', () => {
    const clickable = toSystemNotification(
      { title: 'a', body: 'b', critical: false },
      { sticky: false, clickable: true },
    );
    const built = buildNotifyCommand('linux', clickable);
    // Two argv items: `--action` then `key=label`, the form this notify-send is known to accept.
    expect(built?.args).toContain('--action');
    expect(built?.args).toContain('default=Open Amulet');
    expect(built?.args).toContain('--id-fd=3');
    // An action means a process that waits for the click, so the banner must be guaranteed to die.
    expect(built?.args).toContain('--expire-time=30000');
  });

  it('asks for neither action nor tier where the platform cannot carry them', () => {
    const clickable = toSystemNotification(
      { title: 'a', body: 'b', critical: false },
      { sticky: false, clickable: true },
    );
    // `display notification` and a balloon tip have no actions: a click that can never be reported must
    // not be advertised as one. (The host also never asks for one off X11.)
    expect(
      buildNotifyCommand('darwin', clickable)?.args.join(' '),
    ).not.toContain('--action');
    expect(
      buildNotifyCommand('win32', clickable)?.args.join(' '),
    ).not.toContain('action');
  });

  it('never attaches a click action to a pinned banner', () => {
    expect(pinned.action).toBeUndefined();
    expect(
      toSystemNotification(
        { title: 'a', body: 'b', critical: true },
        {
          sticky: true,
          clickable: true,
        },
      ).action,
    ).toBeUndefined();
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

  describe('runNotifyCommand against a real child', () => {
    // A stand-in for `notify-send`: an id on fd 3, then, much later, the chosen action on stdout.
    const fake = (script: string): NotifyCommand => ({
      command: process.execPath,
      args: ['-e', script],
    });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Until the child has exited and reported its action, rather than a fixed sleep. */
    const until = async (done: () => boolean, budget = 3_000) => {
      for (let spent = 0; spent < budget; spent += 25) {
        if (done()) return true;
        await wait(25);
      }
      return false;
    };

    it('takes the id on fd 3 as the receipt, and resolves before the waiter exits', async () => {
      const actions: string[] = [];
      const started = Date.now();
      const result = await runNotifyCommand(
        fake(
          "require('fs').writeSync(3, '42\\n'); setTimeout(() => process.stdout.write('default'), 600)",
        ),
        { onAction: (key) => actions.push(key) },
      );
      // The child is deliberately still alive: that is the whole point of the id channel.
      expect(result.delivered).toBe(true);
      expect(Date.now() - started).toBeLessThan(500);
      expect(await until(() => actions.length > 0)).toBe(true);
      expect(actions).toEqual(['default']);
    });

    it('reads id 0 as "the server refused to post it"', async () => {
      const result = await runNotifyCommand(
        fake("require('fs').writeSync(3, '0\\n')"),
      );
      expect(result.delivered).toBe(false);
    });

    it('falls back to the exit for a notifier too old for --id-fd', async () => {
      expect((await runNotifyCommand(fake('process.exit(0)'))).delivered).toBe(
        true,
      );
      expect((await runNotifyCommand(fake('process.exit(1)'))).delivered).toBe(
        false,
      );
    });
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
