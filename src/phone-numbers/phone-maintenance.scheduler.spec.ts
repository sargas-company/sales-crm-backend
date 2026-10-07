/**
 * PhoneMaintenanceScheduler — reminder delivery regression.
 *
 * Covers:
 *   - sendDailyReminder() posts to the active DiscordProfile's
 *     opsChannelId via the bot, NOT a webhook URL;
 *   - managerRoleId is included as a `<@&roleId>` prefix AND is the
 *     only id in allowed_mentions.roles — @everyone, @here and any
 *     stray role/user id in the body cannot ping the channel;
 *   - a user-supplied line that contains sentinels like `@everyone`
 *     does not cause a mention — allowed_mentions.parse is empty;
 *   - missing active profile OR missing opsChannelId → the method
 *     records a failed audit event and bumps PhoneReminderLog.success
 *     to false (retryable on the next tick);
 *   - sendTestPing() reads the active profile every call so a TEST ↔
 *     PRODUCTION swap takes effect immediately.
 *
 * Prisma is stubbed in-memory; the bot is stubbed via jest.fn().
 */
import { describe, expect, it, jest } from '@jest/globals';
import { AuditResult } from '@prisma/client';

import { PhoneMaintenanceScheduler } from './phone-maintenance.scheduler';
import { SK } from '../settings/settings-registry';
import type { DiscordBotClient } from '../discord-integration/discord-bot.client';

type PostMessageArgs = {
  channelId: string;
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  allowedMentions?: Record<string, unknown>;
};

type PostMessageResult =
  | { ok: true; messageId: string }
  | { ok: false; status: number; message: string };

interface Profile {
  name: 'TEST' | 'PRODUCTION';
  active: boolean;
  opsChannelId: string | null;
  managerRoleId: string | null;
}

function makeState(opts: {
  profiles: Profile[];
  enabled?: boolean;
  openTasks?: Array<{
    id: string;
    status: 'DUE' | 'OVERDUE';
    dueAt: Date;
    networkRegisteredAt: Date | null;
    toppedUpAt: Date | null;
    phoneNumber: { number: string; operator: string };
  }>;
}) {
  const openTasks = opts.openTasks ?? [];
  const reminderUpserts: unknown[] = [];
  const auditCalls: unknown[] = [];
  const prisma = {
    discordProfile: {
      findFirst: jest.fn(async (args?: unknown) => {
        const where = (args as { where?: { active?: boolean } } | undefined)
          ?.where;
        const list = opts.profiles.filter((p) =>
          where?.active === true ? p.active : true,
        );
        return list[0] ?? null;
      }),
    },
    phoneReminderLog: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args: unknown) => {
        reminderUpserts.push(args);
        return null;
      }),
    },
    phoneMaintenance: {
      updateMany: jest.fn(async () => ({ count: openTasks.length })),
    },
  };
  const settings = {
    getBooleanForKey: jest.fn(async (key: string, def: boolean) => {
      if (key === SK.PHONE_ALERTS_ENABLED) return opts.enabled ?? true;
      return def;
    }),
    getNumberForKey: jest.fn(async (_k: string, def: number) => def),
    getStringForKey: jest.fn(async (_k: string, def: string) => def),
  };
  const maintenance = {
    listOpen: jest.fn(async () => openTasks),
    ensureTasks: jest.fn(async () => undefined),
  };
  const audit = {
    recordSafe: jest.fn(async (args: unknown) => {
      auditCalls.push(args);
    }),
  };
  const config = { get: jest.fn(() => undefined) };
  return { prisma, settings, maintenance, audit, config, reminderUpserts, auditCalls };
}

function makeBot(impl: (args: PostMessageArgs) => Promise<PostMessageResult>) {
  const postMessage = jest.fn(impl);
  return { postMessage } as unknown as DiscordBotClient & {
    postMessage: jest.Mock;
  };
}

const sampleOpenTask = {
  id: 't-1',
  status: 'DUE' as const,
  dueAt: new Date('2026-02-01T00:00:00.000Z'),
  networkRegisteredAt: null,
  toppedUpAt: null,
  phoneNumber: { number: '380991234567', operator: 'Kyivstar' },
};

function buildScheduler(
  state: ReturnType<typeof makeState>,
  bot: DiscordBotClient,
) {
  return new PhoneMaintenanceScheduler(
    state.prisma as never,
    state.maintenance as never,
    state.settings as never,
    state.audit as never,
    state.config as never,
    bot,
  );
}

describe('PhoneMaintenanceScheduler.sendDailyReminder — bot path', () => {
  it('posts to active profile opsChannelId with managerRoleId mention + role-only allowed_mentions', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'PRODUCTION',
          active: true,
          opsChannelId: '555555555555555555',
          managerRoleId: '777777777777777777',
        },
      ],
      openTasks: [sampleOpenTask],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'm-1' }));
    const scheduler = buildScheduler(state, bot);

    await scheduler.sendDailyReminder(new Date('2026-02-01T07:00:00.000Z'));

    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.channelId).toBe('555555555555555555');
    expect(call.allowedMentions).toEqual({
      parse: [],
      roles: ['777777777777777777'],
    });
    expect(call.content).toContain('<@&777777777777777777>');
    // Success leg bumps the idempotency log + audit SUCCESS.
    expect(state.reminderUpserts.length).toBeGreaterThan(0);
    const audits = state.auditCalls as Array<{
      action: string;
      result: AuditResult;
    }>;
    expect(audits[audits.length - 1].action).toBe(
      'phone.maintenance.reminder.sent',
    );
    expect(audits[audits.length - 1].result).toBe(AuditResult.SUCCESS);
  });

  it('a @everyone / @here sentinel in the body does not create a ping — parse is empty', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'TEST',
          active: true,
          opsChannelId: '101010101010101010',
          managerRoleId: null,
        },
      ],
      openTasks: [
        {
          ...sampleOpenTask,
          phoneNumber: {
            number: '380991234567 @everyone @here',
            operator: 'Kyivstar',
          },
        },
      ],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'm-2' }));
    const scheduler = buildScheduler(state, bot);

    await scheduler.sendDailyReminder(new Date('2026-02-01T07:00:00.000Z'));

    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.allowedMentions).toEqual({ parse: [] });
    // Role array is omitted when no managerRoleId is configured.
    expect((call.allowedMentions as { roles?: unknown }).roles).toBeUndefined();
  });

  it('no active profile → records FAILED audit, does not call the bot', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'TEST',
          active: false,
          opsChannelId: '1',
          managerRoleId: null,
        },
      ],
      openTasks: [sampleOpenTask],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'nope' }));
    const scheduler = buildScheduler(state, bot);

    await scheduler.sendDailyReminder(new Date('2026-02-01T07:00:00.000Z'));

    expect(bot.postMessage).not.toHaveBeenCalled();
    const audits = state.auditCalls as Array<{
      action: string;
      result: AuditResult;
    }>;
    const failed = audits.find(
      (a) => a.action === 'phone.maintenance.reminder.failed',
    );
    expect(failed).toBeDefined();
    expect(failed!.result).toBe(AuditResult.FAILED);
  });

  it('active profile without opsChannelId → records FAILED audit', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'TEST',
          active: true,
          opsChannelId: null,
          managerRoleId: null,
        },
      ],
      openTasks: [sampleOpenTask],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'nope' }));
    const scheduler = buildScheduler(state, bot);

    await scheduler.sendDailyReminder(new Date('2026-02-01T07:00:00.000Z'));

    expect(bot.postMessage).not.toHaveBeenCalled();
    const audits = state.auditCalls as Array<{
      action: string;
      result: AuditResult;
    }>;
    expect(
      audits.find((a) => a.action === 'phone.maintenance.reminder.failed')!
        .result,
    ).toBe(AuditResult.FAILED);
  });
});

describe('PhoneMaintenanceScheduler.sendTestPing — bot path', () => {
  it('posts the test ping to the active profile opsChannelId', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'PRODUCTION',
          active: true,
          opsChannelId: '313131313131313131',
          managerRoleId: null,
        },
      ],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 't-1' }));
    const scheduler = buildScheduler(state, bot);

    const res = await scheduler.sendTestPing();
    expect(res.success).toBe(true);
    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.channelId).toBe('313131313131313131');
    expect(call.allowedMentions).toEqual({ parse: [] });
  });

  it('TEST ↔ PRODUCTION swap is picked up on the very next call', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'TEST',
          active: true,
          opsChannelId: '111111111111111111',
          managerRoleId: null,
        },
      ],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 's' }));
    const scheduler = buildScheduler(state, bot);

    await scheduler.sendTestPing();
    expect(
      (bot.postMessage.mock.calls[0][0] as PostMessageArgs).channelId,
    ).toBe('111111111111111111');

    // Swap active profile in-place.
    state.prisma.discordProfile.findFirst.mockImplementation(async () => ({
      name: 'PRODUCTION',
      active: true,
      opsChannelId: '999999999999999999',
      managerRoleId: '888888888888888888',
    }));

    await scheduler.sendTestPing();
    const second = bot.postMessage.mock.calls[1][0] as PostMessageArgs;
    expect(second.channelId).toBe('999999999999999999');
    expect(second.allowedMentions).toEqual({
      parse: [],
      roles: ['888888888888888888'],
    });
  });

  it('no active profile → success:false, bot never called', async () => {
    const state = makeState({
      profiles: [
        {
          name: 'TEST',
          active: false,
          opsChannelId: '1',
          managerRoleId: null,
        },
      ],
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'never' }));
    const scheduler = buildScheduler(state, bot);

    const res = await scheduler.sendTestPing();
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/No active DiscordProfile/);
    expect(bot.postMessage).not.toHaveBeenCalled();
  });
});
