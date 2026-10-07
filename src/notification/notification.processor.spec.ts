/**
 * NotificationProcessorService — delivery-record + routing regression.
 *
 * Covers the unified bot-based architecture:
 *   - JOB_POST_MATCH → JobPostDiscordNotifierService → salesChannelId;
 *     the processor records SENT exactly once and never calls the PMS
 *     path.
 *   - CLIENT_REQUEST → active DiscordProfile.pmsChannelId via
 *     DiscordBotClient; a different active profile (TEST vs
 *     PRODUCTION) is picked up on the next send without a restart.
 *   - CALL_REMINDER → active DiscordProfile.pmsChannelId; mentions are
 *     hard-disabled via allowed_mentions.parse: [].
 *   - Missing active profile or pmsChannelId → the processor throws
 *     a retryable error, delivery stays non-SENT, failedAttempts
 *     increments.
 *   - A repeat worker call for the same SENT event is a no-op
 *     (idempotency).
 *   - Bot errors are sanitised (Bot <token> redaction) before landing
 *     in the error column.
 *
 * Prisma is live for NotificationEvent / NotificationDelivery /
 * DiscordProfile; the DiscordBotClient and JobPostDiscordNotifierService
 * are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationType,
  PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

import { NotificationProcessorService } from './notification.processor';
import type { DiscordBotClient } from '../discord-integration/discord-bot.client';
import type { JobPostDiscordNotifierService } from './job-post-discord-notifier.service';
import type { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaClient();
const TAG = `np-${randomUUID().slice(0, 8)}`;

/**
 * In-process DiscordProfile override — avoids racing against other
 * spec files that also mutate the shared DiscordProfile rows (e.g.
 * JobPostDiscordNotifierService's own spec) when Jest runs test
 * files in parallel workers. All other Prisma delegates still go
 * through the real client so NotificationEvent/NotificationDelivery
 * bookkeeping is exercised end to end.
 */
type ProfileState = {
  name: 'TEST' | 'PRODUCTION';
  pmsChannelId: string | null;
  salesChannelId: string | null;
  opsChannelId: string | null;
  managerRoleId: string | null;
} | null;
let currentProfile: ProfileState = null;
function setActiveProfile(p: ProfileState) {
  currentProfile = p;
}
function makePrismaWithProfile(): PrismaService {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'discordProfile') {
        return {
          findFirst: async () => currentProfile,
          findUnique: async () => currentProfile,
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaService;
}

function makeConfig(): ConfigService {
  return { get: (_k: string) => undefined } as unknown as ConfigService;
}

function makeJobPostNotifier(impl: () => Promise<void>) {
  const send = jest.fn(impl);
  return { send } as unknown as JobPostDiscordNotifierService & { send: jest.Mock };
}

type PostMessageArgs = {
  channelId: string;
  content?: string;
  embeds?: Array<Record<string, unknown>>;
  allowedMentions?: Record<string, unknown>;
};

function makeBot(
  impl: (
    args: PostMessageArgs,
  ) => Promise<
    | { ok: true; messageId: string }
    | { ok: false; status: number; message: string }
  >,
) {
  const postMessage = jest.fn(impl);
  return { postMessage } as unknown as DiscordBotClient & {
    postMessage: jest.Mock;
  };
}

async function createEvent(
  type: NotificationType,
  payload: object,
): Promise<string> {
  const row = await prisma.notificationEvent.create({
    data: { type, payload: payload as never },
    select: { id: true },
  });
  return row.id;
}

function activateProfile(
  name: 'TEST' | 'PRODUCTION',
  patch: {
    pmsChannelId?: string | null;
    salesChannelId?: string | null;
    opsChannelId?: string | null;
  },
) {
  setActiveProfile({
    name,
    pmsChannelId: patch.pmsChannelId ?? null,
    salesChannelId: patch.salesChannelId ?? null,
    opsChannelId: patch.opsChannelId ?? null,
    managerRoleId: null,
  });
}

function activateProfileFull(
  name: 'TEST' | 'PRODUCTION',
  patch: {
    pmsChannelId?: string | null;
    salesChannelId?: string | null;
    opsChannelId?: string | null;
    managerRoleId?: string | null;
  },
) {
  setActiveProfile({
    name,
    pmsChannelId: patch.pmsChannelId ?? null,
    salesChannelId: patch.salesChannelId ?? null,
    opsChannelId: patch.opsChannelId ?? null,
    managerRoleId: patch.managerRoleId ?? null,
  });
}

const createdEventIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length) {
    await prisma.notificationDelivery.deleteMany({
      where: { eventId: { in: createdEventIds } },
    });
    await prisma.notificationEvent.deleteMany({
      where: { id: { in: createdEventIds } },
    });
    createdEventIds.length = 0;
  }
  // Reset the in-process profile override between tests so one case
  // never leaks a profile state into the next.
  setActiveProfile(null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function invokeJob(svc: NotificationProcessorService, eventId: string) {
  const fakeJob = { name: 'send_notification', data: { eventId }, id: `j-${eventId}` };
  return (svc as unknown as { process: (job: unknown) => Promise<void> }).process(fakeJob);
}

const CLIENT_REQUEST_PAYLOAD = {
  clientRequestId: 'cr-1',
  name: 'Acme Corp',
  email: 'ops@acme.test',
  company: 'Acme',
  services: ['dev', 'qa'],
  message: 'Please help.',
};

const CALL_REMINDER_PAYLOAD = {
  callId: 'call-1',
  callTitle: 'Discovery call',
  reminderType: '10min' as const,
  clientName: 'Jane Doe',
  clientType: 'client_request' as const,
  clientDateTime: '2026-01-01 10:00',
  clientTimezone: 'America/New_York',
  clientTimezoneAbbr: 'EST',
  kyivDateTime: '2026-01-01 17:00',
  durationMin: 30,
  meetingUrl: 'https://meet.example/x',
};

describe('NotificationProcessorService — bot-based routing', () => {
  it('JOB_POST_MATCH → JobPostDiscordNotifierService; bot postMessage never called from processor', async () => {
    const eventId = await createEvent(NotificationType.JOB_POST_MATCH, {
      jobPostId: `${TAG}-ok`,
      score: 90,
    });
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-1' }));
    const jobPost = makeJobPostNotifier(async () => undefined);
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      jobPost,
    );

    await invokeJob(svc, eventId);

    expect(jobPost.send).toHaveBeenCalledTimes(1);
    expect(bot.postMessage).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.SENT);
    expect(delivery.sentAt).not.toBeNull();
    expect(delivery.failedAttempts).toBe(0);
  });

  it('CLIENT_REQUEST → active profile pmsChannelId + managerRoleId mention via bot; delivery = SENT', async () => {
    activateProfileFull('TEST', {
      pmsChannelId: '123456789012345678',
      managerRoleId: '555000111222333444',
    });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-2' }));
    const jobPost = makeJobPostNotifier(async () => undefined);
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      jobPost,
    );

    await invokeJob(svc, eventId);

    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.channelId).toBe('123456789012345678');
    expect(call.content).toBe('<@&555000111222333444>');
    expect(call.allowedMentions).toEqual({
      parse: [],
      roles: ['555000111222333444'],
    });
    expect(call.embeds).toBeDefined();
    expect(jobPost.send).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.SENT);
  });

  it('CLIENT_REQUEST without managerRoleId → no ping, allowed_mentions.parse is empty, no `roles`', async () => {
    activateProfileFull('TEST', {
      pmsChannelId: '123456789012345678',
      managerRoleId: null,
    });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-nopg' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await invokeJob(svc, eventId);

    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.content).toBeUndefined();
    expect(call.allowedMentions).toEqual({ parse: [] });
    expect((call.allowedMentions as { roles?: unknown }).roles).toBeUndefined();
  });

  it('CALL_REMINDER → active profile pmsChannelId + managerRoleId; only that role in allowed_mentions.roles', async () => {
    activateProfileFull('TEST', {
      pmsChannelId: '222222222222222222',
      managerRoleId: '666777888999000111',
    });
    const eventId = await createEvent(
      NotificationType.CALL_REMINDER,
      CALL_REMINDER_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-3' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await invokeJob(svc, eventId);

    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect(call.channelId).toBe('222222222222222222');
    expect(call.content).toBe('<@&666777888999000111>');
    expect(call.allowedMentions).toEqual({
      parse: [],
      roles: ['666777888999000111'],
    });

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.SENT);
  });

  it('arbitrary mentions in user payload cannot ping — allowed_mentions.parse is empty', async () => {
    // Payload contains @everyone / @here sentinels and a stray role
    // snowflake inside the free-text fields. parse:[] + the single
    // managerRoleId in roles[] must block every one of them.
    activateProfileFull('TEST', {
      pmsChannelId: '424242424242424242',
      managerRoleId: '111222333444555666',
    });
    const eventId = await createEvent(NotificationType.CLIENT_REQUEST, {
      ...CLIENT_REQUEST_PAYLOAD,
      name: 'Jane @everyone @here',
      message: 'ping <@&999888777666555444> please <@999999999999999999>',
      services: ['<@&777666555444333222>'],
    });
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-arb' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await invokeJob(svc, eventId);

    const call = bot.postMessage.mock.calls[0][0] as PostMessageArgs;
    expect((call.allowedMentions as { parse: unknown[] }).parse).toEqual([]);
    const roles = (call.allowedMentions as { roles?: string[] }).roles;
    expect(roles).toEqual(['111222333444555666']);
  });

  it('TEST ↔ PRODUCTION switch is picked up on the next send without restart', async () => {
    const bot = makeBot(async () => ({ ok: true, messageId: 'm-sw' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    activateProfile('TEST', { pmsChannelId: '111111111111111111' });
    const eventA = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventA);
    await invokeJob(svc, eventA);

    activateProfile('PRODUCTION', { pmsChannelId: '999999999999999999' });
    const eventB = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventB);
    await invokeJob(svc, eventB);

    expect(bot.postMessage).toHaveBeenCalledTimes(2);
    expect((bot.postMessage.mock.calls[0][0] as PostMessageArgs).channelId).toBe(
      '111111111111111111',
    );
    expect((bot.postMessage.mock.calls[1][0] as PostMessageArgs).channelId).toBe(
      '999999999999999999',
    );
  });

  it('missing active profile → retryable failure; delivery stays non-SENT, failedAttempts increments', async () => {
    await prisma.discordProfile.updateMany({ data: { active: false } });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'never' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await expect(invokeJob(svc, eventId)).rejects.toThrow(
      /No active DiscordProfile/,
    );
    expect(bot.postMessage).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.FAILED);
    expect(delivery.sentAt).toBeNull();
    expect(delivery.failedAttempts).toBe(1);
  });

  it('missing pmsChannelId on the active profile → retryable failure', async () => {
    activateProfile('TEST', { pmsChannelId: null });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'never' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await expect(invokeJob(svc, eventId)).rejects.toThrow(/no pmsChannelId/);
    expect(bot.postMessage).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.FAILED);
  });

  it('replays after SENT are no-ops (idempotency) — CLIENT_REQUEST path', async () => {
    activateProfile('TEST', { pmsChannelId: '333333333333333333' });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({ ok: true, messageId: 'm-dup' }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await invokeJob(svc, eventId);
    await invokeJob(svc, eventId);
    await invokeJob(svc, eventId);

    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    const count = await prisma.notificationDelivery.count({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(count).toBe(1);
  });

  it('bot returns ok:false → delivery stays non-SENT, failedAttempts increments, rethrows', async () => {
    activateProfile('TEST', { pmsChannelId: '444444444444444444' });
    const eventId = await createEvent(
      NotificationType.CLIENT_REQUEST,
      CLIENT_REQUEST_PAYLOAD,
    );
    createdEventIds.push(eventId);

    const bot = makeBot(async () => ({
      ok: false,
      status: 403,
      message: 'Missing Access',
    }));
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      bot,
      makeJobPostNotifier(async () => undefined),
    );

    await expect(invokeJob(svc, eventId)).rejects.toThrow('Missing Access');

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.FAILED);
    expect(delivery.failedAttempts).toBe(1);
    expect(delivery.error).toMatch(/Missing Access/);
  });

  it('sanitises Bot token substrings before writing to the error column', async () => {
    const eventId = await createEvent(NotificationType.JOB_POST_MATCH, {
      jobPostId: `${TAG}-redact`,
      score: 90,
    });
    createdEventIds.push(eventId);

    const jobPost = makeJobPostNotifier(async () => {
      throw new Error('upstream said: Bot leaked.secret.token-oops');
    });
    const svc = new NotificationProcessorService(
      makePrismaWithProfile(),
      makeConfig(),
      makeBot(async () => ({ ok: true, messageId: 'never' })),
      jobPost,
    );

    await expect(invokeJob(svc, eventId)).rejects.toThrow();
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.error).toContain('Bot <redacted>');
    expect(delivery.error).not.toContain('leaked.secret.token-oops');
  });
});
