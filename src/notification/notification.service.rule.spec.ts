/**
 * NotificationService.handleJobPostMatch rule filter — scanner-core
 * side.
 *
 * Covers:
 *   - alertsEnabled=false → no queue enqueue;
 *   - score below threshold → no queue enqueue;
 *   - alertsEnabled=true + score ≥ threshold → event enqueued; no
 *     dependency on DISCORD_WEBHOOK_URL any more (the processor owns
 *     the delivery target choice).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { NotificationType, type NotificationEvent } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';

import { NotificationService } from './notification.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';

function makeSettings(flags: {
  alertsEnabled: boolean;
  minScore: number;
}): SettingsService {
  return {
    getBooleanForKey: async (key: string, def: boolean) => {
      if (key === 'scanner.discordAlertsEnabled') return flags.alertsEnabled;
      return def;
    },
    getNumberForKey: async (key: string, def: number) => {
      if (key === 'scanner.discordScoreThreshold') return flags.minScore;
      return def;
    },
    getNumber: async (_k: unknown, def: number) => def,
  } as unknown as SettingsService;
}

function makePrisma(event: NotificationEvent) {
  const create = jest.fn(async () => event);
  const findUnique = jest.fn(async () => event);
  const deliveryFindFirst = jest.fn(async () => null);
  const deliveryCreate = jest.fn(async (args: { data: unknown }) => args.data);
  const deliveryUpdate = jest.fn(async (args: { data: unknown }) => args.data);
  const deliveryCreateMany = jest.fn(async () => ({ count: 0 }));
  return {
    notificationEvent: { create, findUnique, findMany: jest.fn(async () => []) },
    notificationDelivery: {
      findFirst: deliveryFindFirst,
      create: deliveryCreate,
      update: deliveryUpdate,
      createMany: deliveryCreateMany,
    },
  } as unknown as PrismaService & {
    notificationEvent: { create: jest.Mock; findUnique: jest.Mock };
    notificationDelivery: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      createMany: jest.Mock;
    };
  };
}

function makeQueue() {
  const add = jest.fn(async () => undefined);
  const close = jest.fn(async () => undefined);
  return { add, close } as unknown as {
    add: jest.Mock;
    close: jest.Mock;
  };
}

async function buildService(
  flags: { alertsEnabled: boolean; minScore: number },
  event: NotificationEvent,
) {
  const settings = makeSettings(flags);
  const prisma = makePrisma(event);
  const config = { get: () => undefined } as unknown as ConfigService;
  const svc = new NotificationService(prisma, config, settings);
  // Stub the private queue the service builds in onModuleInit.
  const queue = makeQueue();
  (svc as unknown as { queue: unknown }).queue = queue;
  return { svc, queue, prisma };
}

function makeEvent(payload: object): NotificationEvent {
  return {
    id: 'evt-rule',
    type: NotificationType.JOB_POST_MATCH,
    payload: payload as never,
    createdAt: new Date(),
  };
}

describe('NotificationService.handleJobPostMatch — rule filter', () => {
  const basePayload = {
    jobPostId: 'jp-1',
    score: 72,
    title: 't',
    url: 'https://u',
    decision: 'approve',
    priority: 'high',
    rawText: 'x',
  };

  it('enqueues when alerts enabled + score ≥ threshold (no DISCORD_WEBHOOK_URL check)', async () => {
    const event = makeEvent(basePayload);
    const { svc, queue } = await buildService(
      { alertsEnabled: true, minScore: 50 },
      event,
    );
    await (
      svc as unknown as {
        handleJobPostMatch: (e: NotificationEvent) => Promise<void>;
      }
    ).handleJobPostMatch(event);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does NOT enqueue when alerts are disabled; writes SKIPPED delivery row', async () => {
    const event = makeEvent(basePayload);
    const { svc, queue, prisma } = await buildService(
      { alertsEnabled: false, minScore: 50 },
      event,
    );
    await (
      svc as unknown as {
        handleJobPostMatch: (e: NotificationEvent) => Promise<void>;
      }
    ).handleJobPostMatch(event);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: event.id,
        channel: 'DISCORD',
        status: 'SKIPPED',
        error: 'alerts-disabled',
      }),
    });
  });

  it('does NOT enqueue when score is below threshold; writes SKIPPED delivery row', async () => {
    const event = makeEvent({ ...basePayload, score: 40 });
    const { svc, queue, prisma } = await buildService(
      { alertsEnabled: true, minScore: 50 },
      event,
    );
    await (
      svc as unknown as {
        handleJobPostMatch: (e: NotificationEvent) => Promise<void>;
      }
    ).handleJobPostMatch(event);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: event.id,
        channel: 'DISCORD',
        status: 'SKIPPED',
        error: 'below-threshold',
      }),
    });
  });
});
