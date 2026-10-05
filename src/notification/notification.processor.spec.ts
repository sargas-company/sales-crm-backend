/**
 * NotificationProcessorService — delivery-record + routing regression.
 *
 * Covers:
 *   - JOB_POST_MATCH → JobPostDiscordNotifierService; the legacy
 *     DiscordNotificationService.send webhook is NEVER called;
 *   - bot ok=true → NotificationDelivery flips to SENT exactly once;
 *   - a repeat worker call for the same event is a no-op (idempotency);
 *   - bot failure → delivery stays non-SENT, failedAttempts increments,
 *     error field holds the sanitised message, the error rethrows so
 *     BullMQ retries.
 *
 * Prisma is live; both sender collaborators are stubbed.
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
import type { DiscordNotificationService } from './discord.service';
import type { JobPostDiscordNotifierService } from './job-post-discord-notifier.service';
import type { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaClient();
const TAG = `np-${randomUUID().slice(0, 8)}`;

/* We never actually initialise the BullMQ worker — tests drive the
   private process() by invoking it directly via `(svc as any).process`.
   The onModuleInit path (which spins up IORedis) is deliberately
   bypassed, so no Redis dependency in tests. */

function makeConfig(): ConfigService {
  return { get: (_k: string) => undefined } as unknown as ConfigService;
}

function makeJobPostNotifier(impl: () => Promise<void>) {
  const send = jest.fn(impl);
  return { send } as unknown as JobPostDiscordNotifierService & { send: jest.Mock };
}

function makeWebhookService() {
  const send = jest.fn(async (_body: unknown) => undefined);
  return { send } as unknown as DiscordNotificationService & { send: jest.Mock };
}

async function createEvent(payload: object): Promise<string> {
  const row = await prisma.notificationEvent.create({
    data: {
      type: NotificationType.JOB_POST_MATCH,
      payload: payload as never,
    },
    select: { id: true },
  });
  return row.id;
}

const createdEventIds: string[] = [];

beforeAll(async () => {
  // nothing — the test seeds events per case.
});

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
});

afterAll(async () => {
  await prisma.$disconnect();
});

function invokeJob(svc: NotificationProcessorService, eventId: string) {
  const fakeJob = { name: 'send_notification', data: { eventId }, id: `j-${eventId}` };
  return (svc as unknown as { process: (job: unknown) => Promise<void> }).process(fakeJob);
}

describe('NotificationProcessorService — JOB_POST_MATCH routing', () => {
  it('bot success → NotificationDelivery = SENT, legacy webhook never called', async () => {
    const eventId = await createEvent({ jobPostId: `${TAG}-ok`, score: 90 });
    createdEventIds.push(eventId);

    const bot = makeJobPostNotifier(async () => undefined);
    const webhook = makeWebhookService();
    const svc = new NotificationProcessorService(
      prisma as unknown as PrismaService,
      makeConfig(),
      webhook,
      bot,
    );

    await invokeJob(svc, eventId);

    expect(bot.send).toHaveBeenCalledTimes(1);
    expect(webhook.send).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.SENT);
    expect(delivery.sentAt).not.toBeNull();
    expect(delivery.failedAttempts).toBe(0);
  });

  it('replays after SENT are no-ops (idempotency)', async () => {
    const eventId = await createEvent({ jobPostId: `${TAG}-dup`, score: 90 });
    createdEventIds.push(eventId);

    const bot = makeJobPostNotifier(async () => undefined);
    const webhook = makeWebhookService();
    const svc = new NotificationProcessorService(
      prisma as unknown as PrismaService,
      makeConfig(),
      webhook,
      bot,
    );
    await invokeJob(svc, eventId);
    await invokeJob(svc, eventId);
    await invokeJob(svc, eventId);

    expect(bot.send).toHaveBeenCalledTimes(1);
    const count = await prisma.notificationDelivery.count({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(count).toBe(1);
  });

  it('bot failure → delivery stays non-SENT, failedAttempts increments, rethrows for BullMQ retry', async () => {
    const eventId = await createEvent({ jobPostId: `${TAG}-fail`, score: 90 });
    createdEventIds.push(eventId);

    const bot = makeJobPostNotifier(async () => {
      throw new Error('Discord postMessage 403: Missing Access');
    });
    const webhook = makeWebhookService();
    const svc = new NotificationProcessorService(
      prisma as unknown as PrismaService,
      makeConfig(),
      webhook,
      bot,
    );

    await expect(invokeJob(svc, eventId)).rejects.toThrow('Missing Access');
    expect(webhook.send).not.toHaveBeenCalled();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.status).toBe(NotificationDeliveryStatus.FAILED);
    expect(delivery.sentAt).toBeNull();
    expect(delivery.failedAttempts).toBe(1);
    expect(delivery.error).toMatch(/Missing Access/);
  });

  it('sanitises Bot token substrings before writing to the error column', async () => {
    const eventId = await createEvent({ jobPostId: `${TAG}-redact`, score: 90 });
    createdEventIds.push(eventId);

    const bot = makeJobPostNotifier(async () => {
      // Imagine a stray log entry leaking "Bot <token>" into the message.
      throw new Error('upstream said: Bot leaked.secret.token-oops');
    });
    const webhook = makeWebhookService();
    const svc = new NotificationProcessorService(
      prisma as unknown as PrismaService,
      makeConfig(),
      webhook,
      bot,
    );
    await expect(invokeJob(svc, eventId)).rejects.toThrow();

    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });
    expect(delivery.error).toContain('Bot <redacted>');
    expect(delivery.error).not.toContain('leaked.secret.token-oops');
  });
});
