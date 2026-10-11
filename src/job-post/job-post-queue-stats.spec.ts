/**
 * Spec for `JobPostService.getQueueStats` under the two user-facing
 * scenarios the operator cares about:
 *
 *   • Scenario A — mixed state while AI is active.
 *       1 NEW/BACKLOG + 1 NEW/ENQUEUED with a live BullMQ job
 *       waiting in Redis. Panel must render Backlog=2, Pending=0,
 *       In queue=1, Running=0.
 *   • Scenario B — Redis unavailable while AI is active.
 *       2 NEW/PENDING rows, queueCounts throws. Panel must render
 *       Backlog=2, Pending=2, In queue=—, Running=—.
 *
 * These scenarios are isolated through stubs; no DB or Redis is
 * touched, so the user's local DB/queue is unchanged.
 */
import { describe, expect, it, jest } from '@jest/globals';

import { JobPostService } from './job-post.service';
import type { JobPostQueueService } from './job-post-queue.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SettingsService } from '../settings/settings.service';
import type { LiveEventsService } from '../live-events/live-events.service';
import type { AiJobEvaluatorService } from './ai-job-evaluator.service';

type GroupByRow = {
  status: string;
  enqueueState: string | null;
  _count: { _all: number };
};

function makeSvc(
  groupBy: GroupByRow[],
  queueCountsImpl: () => Promise<{
    waiting: number;
    delayed: number;
    active: number;
    paused: number;
    prioritized: number;
  }>,
  analysisEnabled = true,
) {
  const prisma = {
    jobPost: {
      groupBy: jest.fn<() => Promise<GroupByRow[]>>().mockResolvedValue(groupBy),
    },
  } as unknown as PrismaService;
  const settings = {
    getBooleanForKey: jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(analysisEnabled),
  } as unknown as SettingsService;
  const queue = {
    queueCounts: jest.fn().mockImplementation(queueCountsImpl),
  } as unknown as JobPostQueueService;
  const liveEvents = {} as unknown as LiveEventsService;
  const evaluator = {
    gateModel: () => 'claude-haiku-5-5',
    evalModel: () => 'claude-sonnet-5-5',
  } as unknown as AiJobEvaluatorService;
  return new JobPostService(prisma, settings, queue, liveEvents, evaluator);
}

describe('getQueueStats — operator-facing scenarios', () => {
  it('A: 1 NEW/BACKLOG + 1 NEW/ENQUEUED, Redis has 1 waiting → Backlog=2, Pending=0, In queue=1, Running=0', async () => {
    const svc = makeSvc(
      [
        { status: 'NEW', enqueueState: 'BACKLOG', _count: { _all: 1 } },
        { status: 'NEW', enqueueState: 'ENQUEUED', _count: { _all: 1 } },
      ],
      async () => ({
        waiting: 1,
        delayed: 0,
        active: 0,
        paused: 0,
        prioritized: 0,
      }),
    );
    const stats = await svc.getQueueStats();
    expect(stats.totalNew).toBe(2);
    expect(stats.backlog).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.inQueue).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.redisAvailable).toBe(true);
    expect(stats.failed).toBe(0);
  });

  it('A2: same mix with queue globally paused (waiting→paused): In queue still 1', async () => {
    const svc = makeSvc(
      [
        { status: 'NEW', enqueueState: 'BACKLOG', _count: { _all: 1 } },
        { status: 'NEW', enqueueState: 'ENQUEUED', _count: { _all: 1 } },
      ],
      async () => ({
        waiting: 0,
        delayed: 0,
        active: 0,
        paused: 1, // BullMQ rebuckets waiting → paused when isPaused=true
        prioritized: 0,
      }),
    );
    const stats = await svc.getQueueStats();
    expect(stats.totalNew).toBe(2);
    expect(stats.backlog).toBe(1);
    expect(stats.inQueue).toBe(1);
    expect(stats.running).toBe(0);
  });

  it('B: 2 NEW/PENDING, Redis unavailable → Backlog=2, Pending=2, In queue=null, Running=null, redisAvailable=false', async () => {
    const svc = makeSvc(
      [{ status: 'NEW', enqueueState: 'PENDING', _count: { _all: 2 } }],
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    const stats = await svc.getQueueStats();
    expect(stats.totalNew).toBe(2);
    expect(stats.backlog).toBe(0);
    expect(stats.pending).toBe(2);
    expect(stats.inQueue).toBeNull();
    expect(stats.running).toBeNull();
    expect(stats.redisAvailable).toBe(false);
    expect(stats.queueWaiting).toBeNull();
    expect(stats.queueActive).toBeNull();
  });
});
