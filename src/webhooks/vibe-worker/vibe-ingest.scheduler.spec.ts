/**
 * VibeIngestScheduler — durability tick regression tests.
 *
 * Covers:
 *   - inboxDrainTick walks RECEIVED events and flips them to PROCESSED
 *     without the HTTP controller doing it synchronously;
 *   - a scanner.analysisEnabled false→true flip drains the backlog on
 *     the very next tick, no restart required;
 *   - a queue failure leaves JobPost(status=NEW); queueReconcileTick
 *     re-enqueues it successfully on the next tick (Redis back);
 *   - queueReconcileTick does NOT touch PROCESSING rows (the startup
 *     recovery owns that cleanup);
 *   - two parallel tick calls inside the same process do not
 *     double-enqueue a row (in-process guard + advisory lock);
 *   - a single providerJobId never gets a second JobPost or a second
 *     queue enqueue, no matter how often the tick fires.
 */
import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, JobPostIngestSource, JobPostIngestStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { VibeIngestProcessorService } from './vibe-ingest-processor.service';
import { VibeIngestScheduler } from './vibe-ingest.scheduler';
import type { JobPostQueueService } from '../../job-post/job-post-queue.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../../settings/settings.service';

const prisma = new PrismaClient();
const TAG = `sched-${randomUUID().slice(0, 8)}`;

function makeSettings(getFlag: () => boolean): SettingsService {
  return {
    getBooleanForKey: async (_key: string, _default: boolean) => getFlag(),
  } as unknown as SettingsService;
}

function makeQueue(opts?: { fail?: Error | null }) {
  const calls: string[] = [];
  const enqueue = jest.fn(async (id: string) => {
    calls.push(id);
    if (opts?.fail) throw opts.fail;
  });
  return {
    calls,
    enqueue,
    service: { enqueue } as unknown as JobPostQueueService,
  };
}

function payload(providerJobId: string) {
  return {
    event: 'job.matched',
    filterName: 'All Jobs',
    matchedAt: new Date().toISOString(),
    job: {
      id: providerJobId,
      url: `https://x.test/${providerJobId}`,
      type: 'hourly',
      title: `vac ${providerJobId}`,
      description: 'test',
      budget: { min: 10, max: 20, display: null, currency: 'USD' },
      skills: ['Node.js'],
      duration: null,
      postedAt: new Date().toISOString(),
      questions: [],
      categories: [],
      contractType: null,
      hoursPerWeek: null,
      experienceLevel: null,
      connectsRequired: null,
    },
    match: {
      reasoning: 'test',
      scoreQuickWin: 10,
      scoreRedFlags: 0,
      scoreScopeClarity: 10,
      effortEstimateHours: 1,
    },
    client: {
      hires: 1,
      rating: 5,
      hireRate: 1,
      location: 'Earth',
      rankLabel: null,
      rankScore: null,
      jobsPosted: 1,
      totalSpent: 100,
      reviewCount: 1,
      avgHourlyRate: 10,
      paymentVerified: true,
      locationRestriction: null,
    },
  };
}

async function createEvent(p: unknown): Promise<string> {
  const row = await prisma.jobPostIngestEvent.create({
    data: {
      source: JobPostIngestSource.VIBE_WORKER,
      idempotencyKey: `vibe:test:${randomUUID()}`,
      payload: p as never,
    },
    select: { id: true },
  });
  return row.id;
}

const createdEventIds: string[] = [];
const createdJobPostIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length) {
    await prisma.jobPostIngestEvent.deleteMany({
      where: { id: { in: createdEventIds } },
    });
    createdEventIds.length = 0;
  }
  if (createdJobPostIds.length) {
    await prisma.jobPost.deleteMany({ where: { id: { in: createdJobPostIds } } });
    createdJobPostIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSched(
  queue: ReturnType<typeof makeQueue>,
  settingsFlag: () => boolean,
) {
  const processor = new VibeIngestProcessorService(
    prisma as unknown as PrismaService,
    queue.service,
    makeSettings(settingsFlag),
  );
  const scheduler = new VibeIngestScheduler(
    prisma as unknown as PrismaService,
    processor,
    queue.service,
  );
  return { processor, scheduler };
}

describe('inbox drain — tick-based processing', () => {
  it('processes a RECEIVED event without the controller invoking anything', async () => {
    const providerId = `${TAG}_tick1_${Date.now()}`;
    const eventId = await createEvent(payload(providerId));
    createdEventIds.push(eventId);
    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => true);

    await scheduler.inboxDrainTick();

    const ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.status).toBe(JobPostIngestStatus.PROCESSED);
    expect(ev.jobPostId).toBeTruthy();
    createdJobPostIds.push(ev.jobPostId!);
    expect(queue.calls).toEqual([ev.jobPostId]);
  });

  it('analysisEnabled false → true drains backlog on the NEXT tick without restart', async () => {
    const providerId = `${TAG}_flip_${Date.now()}`;
    const eventId = await createEvent(payload(providerId));
    createdEventIds.push(eventId);

    let flag = false;
    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => flag);

    // Tick #1 — paused. Nothing moves.
    await scheduler.inboxDrainTick();
    let ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.status).toBe(JobPostIngestStatus.RECEIVED);
    expect(queue.calls).toHaveLength(0);

    // Operator flips scanner.analysisEnabled → true.
    flag = true;

    // Tick #2 — backlog drained.
    await scheduler.inboxDrainTick();
    ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.status).toBe(JobPostIngestStatus.PROCESSED);
    createdJobPostIds.push(ev.jobPostId!);
    expect(queue.calls).toHaveLength(1);
  });

  it('two parallel tick calls do not double-process the same event', async () => {
    const providerId = `${TAG}_par_${Date.now()}`;
    const eventId = await createEvent(payload(providerId));
    createdEventIds.push(eventId);
    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => true);

    await Promise.all([scheduler.inboxDrainTick(), scheduler.inboxDrainTick()]);

    const ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    createdJobPostIds.push(ev.jobPostId!);
    expect(ev.status).toBe(JobPostIngestStatus.PROCESSED);
    const count = await prisma.jobPost.count({ where: { providerJobId: providerId } });
    expect(count).toBe(1);
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]).toBe(ev.jobPostId);
  });
});

describe('queue reconciliation — tick-based retry', () => {
  it('after a Redis failure, JobPost stays NEW; the next tick enqueues it', async () => {
    const providerId = `${TAG}_qfail_${Date.now()}`;
    const eventId = await createEvent(payload(providerId));
    createdEventIds.push(eventId);

    // Tick #1 — Redis is DOWN. Event becomes PROCESSED (DB side) but
    // enqueue throws → JobPost stays NEW.
    const downQueue = makeQueue({ fail: new Error('redis unavailable') });
    const { scheduler: downSched } = buildSched(downQueue, () => true);
    await downSched.inboxDrainTick();
    const ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.status).toBe(JobPostIngestStatus.PROCESSED);
    createdJobPostIds.push(ev.jobPostId!);
    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id: ev.jobPostId! } });
    expect(jp.status).toBe('NEW');

    // Tick #2 — Redis is BACK. queueReconcileTick picks up NEW rows.
    const healthy = makeQueue();
    const upSched = new VibeIngestScheduler(
      prisma as unknown as PrismaService,
      new VibeIngestProcessorService(
        prisma as unknown as PrismaService,
        healthy.service,
        makeSettings(() => true),
      ),
      healthy.service,
    );
    await upSched.queueReconcileTick();
    expect(healthy.calls).toContain(jp.id);
  });

  it('never touches PROCESSING rows (startup owns that recovery)', async () => {
    const providerId = `${TAG}_proc_${Date.now()}`;
    const jp = await prisma.jobPost.create({
      data: {
        providerJobId: providerId,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'PROCESSING',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
      },
      select: { id: true, status: true },
    });
    createdJobPostIds.push(jp.id);

    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => true);
    await scheduler.queueReconcileTick();

    expect(queue.calls).not.toContain(jp.id);
    const after = await prisma.jobPost.findUniqueOrThrow({ where: { id: jp.id } });
    expect(after.status).toBe('PROCESSING');
  });

  it('two parallel reconcile ticks do not double-enqueue a row', async () => {
    const providerId = `${TAG}_pr_${Date.now()}`;
    const jp = await prisma.jobPost.create({
      data: {
        providerJobId: providerId,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'NEW',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
      },
      select: { id: true },
    });
    createdJobPostIds.push(jp.id);
    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => true);

    await Promise.all([scheduler.queueReconcileTick(), scheduler.queueReconcileTick()]);

    expect(queue.calls.filter((id) => id === jp.id)).toHaveLength(1);
  });
});

describe('end-to-end — one providerJobId → one JobPost + one queue job regardless of tick frequency', () => {
  it('many ticks after same payload still yield exactly one JobPost and one enqueue', async () => {
    const providerId = `${TAG}_e2e_${Date.now()}`;
    const eventId = await createEvent(payload(providerId));
    createdEventIds.push(eventId);
    const queue = makeQueue();
    const { scheduler } = buildSched(queue, () => true);

    for (let i = 0; i < 5; i++) {
      await scheduler.inboxDrainTick();
    }
    const after = await prisma.jobPost.findMany({ where: { providerJobId: providerId } });
    expect(after).toHaveLength(1);
    createdJobPostIds.push(after[0].id);
    // Only the first tick that converted RECEIVED→PROCESSED enqueues;
    // subsequent ticks see no RECEIVED work for this provider id.
    expect(queue.calls.filter((id) => id === after[0].id)).toHaveLength(1);
  });
});
