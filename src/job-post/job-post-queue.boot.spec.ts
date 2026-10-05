/**
 * JobPostQueueService boot contract — regression for the
 * "Nest never reaches app.listen()" production incident.
 *
 * `onModuleInit` must do no DB work and no Redis queue operations
 * beyond constructing the Queue, so a non-trivial backlog can't
 * block Nest's bootstrap chain. All former recovery steps belong
 * to `VibeIngestScheduler.queueReconcileTick`, which runs AFTER
 * `app.listen()`.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';

import { JobPostQueueService } from './job-post-queue.service';
import type { PrismaService } from '../prisma/prisma.service';

// We stub `ioredis` and `bullmq.Queue` so the test exercises only
// JobPostQueueService's own code; the point is to assert what the
// service does and does NOT do during init.
jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      quit: jest.fn(async () => undefined),
    })),
  };
});
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn(),
      close: jest.fn(async () => undefined),
    })),
  };
});

function makeConfig(): ConfigService {
  return { get: (_k: string, def?: unknown) => def } as unknown as ConfigService;
}

function makePrismaSpies() {
  const findMany = jest.fn();
  const updateMany = jest.fn();
  const prisma = {
    jobPost: { findMany, updateMany },
  } as unknown as PrismaService;
  return { prisma, findMany, updateMany };
}

describe('JobPostQueueService.onModuleInit — boot contract', () => {
  it('completes without touching Prisma (no DB recovery during init)', async () => {
    const { prisma, findMany, updateMany } = makePrismaSpies();
    const svc = new JobPostQueueService(makeConfig(), prisma);
    const started = Date.now();
    await svc.onModuleInit();
    expect(Date.now() - started).toBeLessThan(500);
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does NOT enqueue anything during init even when NEW rows exist', async () => {
    const { prisma, findMany } = makePrismaSpies();
    // If init cared about rows at all, it would call findMany. It
    // must not — stubbed to blow up to catch any accidental read.
    (findMany as jest.Mock).mockImplementation(() => {
      throw new Error('onModuleInit must not read JobPost');
    });
    const svc = new JobPostQueueService(makeConfig(), prisma);
    const enqueueSpy = jest.spyOn(svc, 'enqueue');
    await svc.onModuleInit();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('resetStuckProcessing is a separate method and only touches rows older than the age floor', async () => {
    const { prisma, updateMany } = makePrismaSpies();
    (updateMany as jest.Mock).mockImplementation(async () => ({ count: 3 }));
    const svc = new JobPostQueueService(makeConfig(), prisma);
    await svc.onModuleInit();
    // Deferred recovery hasn't been called yet — the scheduler owns
    // that trigger, not module init.
    expect(updateMany).not.toHaveBeenCalled();

    const n = await svc.resetStuckProcessing(60_000);
    expect(n).toBe(3);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const callArg = (updateMany as jest.Mock).mock.calls[0][0] as {
      where: { status: string; createdAt: { lt: Date } };
      data: { status: string };
    };
    expect(callArg.where.status).toBe('PROCESSING');
    expect(callArg.where.createdAt.lt).toBeInstanceOf(Date);
    // The cutoff must be in the past by roughly the configured age.
    const ageMs = Date.now() - callArg.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(60_000 - 1_000);
    expect(callArg.data.status).toBe('NEW');
  });
});
