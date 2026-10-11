/**
 * Spec for the ENQUEUED-but-missing-from-Redis sweep.
 *
 * Scenario: a Redis flush (or terminal cleanup race) left JobPost
 * rows in `NEW/ENQUEUED` with no live BullMQ job. These rows would
 * otherwise be invisible to the reconcile tick (which only drives
 * `PENDING`), so `reconcileLostEnqueued` demotes them back to
 * `PENDING` and lets the normal reconcile re-enqueue on the next
 * sweep.
 *
 * Redis-outage safety: if `getJob` throws, the sweep aborts without
 * flipping anything — we never create duplicate work when the
 * Redis-side truth is unknown.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';

import { JobPostQueueService } from './job-post-queue.service';
import type { PrismaService } from '../prisma/prisma.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ quit: jest.fn(async () => undefined) })),
}));
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    close: jest.fn(async () => undefined),
    getJob: jest.fn(async () => null),
    getActive: jest.fn(async () => []),
  })),
}));

function makeConfig(): ConfigService {
  return { get: (_k: string, def?: unknown) => def } as unknown as ConfigService;
}

function makePrismaSpies(rows: Array<{ id: string }>) {
  const findMany = jest.fn().mockResolvedValue(rows as never);
  const updateMany = jest.fn().mockResolvedValue({ count: rows.length } as never);
  const prisma = {
    jobPost: { findMany, updateMany },
  } as unknown as PrismaService;
  return { prisma, findMany, updateMany };
}

describe('reconcileLostEnqueued', () => {
  it('flips ENQUEUED rows with no Redis job back to PENDING', async () => {
    const { prisma, updateMany } = makePrismaSpies([
      { id: 'ghost-1' },
      { id: 'ghost-2' },
    ]);
    const svc = new JobPostQueueService(makeConfig(), prisma);
    await svc.onModuleInit();

    const asAny = svc as unknown as {
      queue: { getJob: jest.Mock };
    };
    asAny.queue.getJob = jest.fn<() => Promise<null>>().mockResolvedValue(null);

    const n = await svc.reconcileLostEnqueued();
    expect(n).toBe(2);
    const arg = (updateMany as jest.Mock).mock.calls[0][0] as {
      where: { status: string; enqueueState: string; id: { in: string[] } };
      data: { enqueueState: string };
    };
    expect(arg.where.status).toBe('NEW');
    expect(arg.where.enqueueState).toBe('ENQUEUED');
    expect(arg.where.id.in.sort()).toEqual(['ghost-1', 'ghost-2']);
    expect(arg.data.enqueueState).toBe('PENDING');
  });

  it('does NOT flip rows that still have a live Redis job', async () => {
    const { prisma, updateMany } = makePrismaSpies([
      { id: 'live' },
      { id: 'ghost' },
    ]);
    const svc = new JobPostQueueService(makeConfig(), prisma);
    await svc.onModuleInit();

    const asAny = svc as unknown as { queue: { getJob: jest.Mock } };
    asAny.queue.getJob = jest
      .fn<(id: string) => Promise<{ id: string } | null>>()
      .mockImplementation(async (id: string) =>
        id === 'live-v1' ? { id: 'live-v1' } : null,
      );

    await svc.reconcileLostEnqueued();
    const arg = (updateMany as jest.Mock).mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(arg.where.id.in).toEqual(['ghost']);
  });

  it('aborts the sweep when Redis is unavailable (never flips without confirmed negative)', async () => {
    const { prisma, updateMany } = makePrismaSpies([{ id: 'maybe-ghost' }]);
    const svc = new JobPostQueueService(makeConfig(), prisma);
    await svc.onModuleInit();

    const asAny = svc as unknown as { queue: { getJob: jest.Mock } };
    asAny.queue.getJob = jest
      .fn<() => Promise<null>>()
      .mockImplementation(async () => {
        throw new Error('redis unavailable');
      });

    const n = await svc.reconcileLostEnqueued();
    expect(n).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
