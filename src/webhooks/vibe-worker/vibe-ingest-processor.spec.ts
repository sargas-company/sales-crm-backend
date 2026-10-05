/**
 * Integration spec for VibeIngestProcessorService — same pattern as
 * project-report-invariants.spec.ts and
 * discord-report-cross-source.spec.ts (live local Postgres).
 *
 * Covers:
 *   - real payload → JobPost(NEW) + ingest event flipped to PROCESSED,
 *     queue.enqueue called exactly once;
 *   - duplicate delivery (same job.id, new ingest event row) does
 *     NOT create a second JobPost and does NOT enqueue again;
 *   - demo / diagnostic payload is SKIPPED, no JobPost created;
 *   - queue enqueue failure does NOT lose the event — JobPost is
 *     committed, event marked PROCESSED. Follow-up boot (recovery
 *     path) is simulated: another processEvent() call is a no-op.
 *   - drainReceived walks every RECEIVED event in receivedAt order.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, JobPostIngestSource, JobPostIngestStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { VibeIngestProcessorService } from './vibe-ingest-processor.service';
import type { JobPostQueueService } from '../../job-post/job-post-queue.service';
import type { SettingsService } from '../../settings/settings.service';
import type { PrismaService } from '../../prisma/prisma.service';

const prisma = new PrismaClient();

const TAG = `vibe-ingest-${randomUUID().slice(0, 8)}`;

function makeSettings(analysisEnabled = true): SettingsService {
  return {
    getBooleanForKey: async (_key: string, _default: boolean) => analysisEnabled,
  } as unknown as SettingsService;
}

function makeQueueStub() {
  const calls: string[] = [];
  const stub = {
    calls,
    enqueue: jest.fn(async (jobPostId: string) => {
      calls.push(jobPostId);
    }),
  };
  return stub as unknown as JobPostQueueService & { calls: string[]; enqueue: jest.Mock };
}

function makeFailingQueue(error = new Error('redis down')) {
  const calls: string[] = [];
  return {
    calls,
    enqueue: jest.fn(async (jobPostId: string) => {
      calls.push(jobPostId);
      throw error;
    }),
  } as unknown as JobPostQueueService & { calls: string[]; enqueue: jest.Mock };
}

function makePayload(providerJobId: string, overrides: Record<string, unknown> = {}) {
  return {
    event: 'job.matched',
    filterName: 'All Jobs',
    matchedAt: new Date().toISOString(),
    job: {
      id: providerJobId,
      url: `https://www.upwork.com/jobs/~${providerJobId}`,
      type: 'hourly',
      title: `Vibe test vacancy ${providerJobId}`,
      description: 'Testing payload — not a real post.',
      budget: { min: 40, max: 70, display: null, currency: 'USD' },
      skills: ['Node.js', 'Prisma'],
      duration: '1-3 months',
      postedAt: new Date().toISOString(),
      questions: [],
      categories: ['Web dev'],
      contractType: 'ongoing',
      hoursPerWeek: '10-20',
      experienceLevel: 'expert',
      connectsRequired: 8,
    },
    match: {
      reasoning: 'Looks relevant',
      scoreQuickWin: 70,
      scoreRedFlags: 10,
      scoreScopeClarity: 80,
      effortEstimateHours: 40,
    },
    client: {
      hires: 10,
      rating: 4.8,
      hireRate: 0.75,
      location: 'United States',
      rankLabel: 'Top rated',
      rankScore: 0.9,
      jobsPosted: 15,
      totalSpent: 5000,
      reviewCount: 8,
      avgHourlyRate: 50,
      paymentVerified: true,
      locationRestriction: null,
    },
    ...overrides,
  };
}

async function captureEvent(payload: unknown): Promise<string> {
  const row = await prisma.jobPostIngestEvent.create({
    data: {
      source: JobPostIngestSource.VIBE_WORKER,
      idempotencyKey: `vibe:test:${randomUUID()}`,
      payload: payload as never,
    },
    select: { id: true },
  });
  return row.id;
}

/* Keep track of what we created so we can clean up after each test. */
const createdJobPostIds: string[] = [];
const createdEventIds: string[] = [];

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

describe('VibeIngestProcessorService — happy path', () => {
  it('creates a JobPost(NEW), links the event, enqueues exactly once', async () => {
    const providerJobId = `vw_${TAG}_hp_${Date.now()}`;
    const eventId = await captureEvent(makePayload(providerJobId));
    createdEventIds.push(eventId);
    const queue = makeQueueStub();
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue,
      makeSettings(true),
    );

    await svc.processEvent(eventId);

    const event = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe(JobPostIngestStatus.PROCESSED);
    expect(event.jobPostId).toBeTruthy();
    createdJobPostIds.push(event.jobPostId!);

    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id: event.jobPostId! } });
    expect(jp.status).toBe('NEW');
    expect(jp.providerJobId).toBe(providerJobId);
    expect(jp.title).toContain('Vibe test vacancy');
    expect(jp.scanner).toBe('vibe-worker');
    expect(jp.totalSpent).toBe(5000);
    expect(jp.avgRatePaid).toBe(50);
    expect(jp.hireRate).toBe(0.75);
    expect(jp.hSkillsKeywords).toEqual(['Node.js', 'Prisma']);
    expect(jp.chatId).toBeNull();
    expect(jp.messageId).toBeNull();

    expect((queue.enqueue as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((queue.enqueue as jest.Mock).mock.calls[0][0]).toBe(jp.id);
  });
});

describe('VibeIngestProcessorService — idempotency', () => {
  it('a second event with the same job.id reuses the JobPost and does NOT re-enqueue', async () => {
    const providerJobId = `vw_${TAG}_dup_${Date.now()}`;
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      makeQueueStub(),
      makeSettings(true),
    );
    const queue1 = makeQueueStub();
    const queue2 = makeQueueStub();

    const eventA = await captureEvent(makePayload(providerJobId));
    createdEventIds.push(eventA);
    const svcA = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue1,
      makeSettings(true),
    );
    await svcA.processEvent(eventA);

    // Second delivery of "same vacancy" — different payload.matchedAt
    // so the ingest-event idempotency key differs, but job.id is the
    // same so JobPost MUST be a reuse.
    const eventB = await captureEvent(
      makePayload(providerJobId, { matchedAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    createdEventIds.push(eventB);
    const svcB = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue2,
      makeSettings(true),
    );
    await svcB.processEvent(eventB);

    const a = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventA } });
    const b = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventB } });
    expect(a.jobPostId).toBe(b.jobPostId);
    expect(a.status).toBe(JobPostIngestStatus.PROCESSED);
    expect(b.status).toBe(JobPostIngestStatus.PROCESSED);
    createdJobPostIds.push(a.jobPostId!);

    const count = await prisma.jobPost.count({ where: { providerJobId } });
    expect(count).toBe(1);

    expect((queue1.enqueue as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((queue2.enqueue as jest.Mock)).not.toHaveBeenCalled();

    // Reference the unused service to satisfy lint without masking the test.
    void svc;
  });
});

describe('VibeIngestProcessorService — demo / diagnostic payloads', () => {
  it('marks a non-job.matched event SKIPPED without creating a JobPost', async () => {
    const eventId = await captureEvent({ hello: 'world', not: 'a job' });
    createdEventIds.push(eventId);
    const queue = makeQueueStub();
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue,
      makeSettings(true),
    );
    await svc.processEvent(eventId);

    const event = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe(JobPostIngestStatus.SKIPPED);
    expect(event.jobPostId).toBeNull();
    expect(event.error).toContain('Vibe');

    expect((queue.enqueue as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('VibeIngestProcessorService — queue failure safety', () => {
  it('leaves JobPost committed as NEW; subsequent processEvent is a no-op', async () => {
    const providerJobId = `vw_${TAG}_qfail_${Date.now()}`;
    const eventId = await captureEvent(makePayload(providerJobId));
    createdEventIds.push(eventId);
    const failing = makeFailingQueue();
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      failing,
      makeSettings(true),
    );
    await svc.processEvent(eventId); // must NOT throw — logger.warn absorbs

    const event = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe(JobPostIngestStatus.PROCESSED);
    createdJobPostIds.push(event.jobPostId!);
    const jp = await prisma.jobPost.findUniqueOrThrow({ where: { id: event.jobPostId! } });
    expect(jp.status).toBe('NEW');

    // Simulate restart: a healthy queue + another processEvent call
    // must NOT create a duplicate JobPost and must NOT enqueue again.
    const healthy = makeQueueStub();
    const svc2 = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      healthy,
      makeSettings(true),
    );
    await svc2.processEvent(eventId);
    expect((healthy.enqueue as jest.Mock)).not.toHaveBeenCalled();
    const after = await prisma.jobPost.count({ where: { providerJobId } });
    expect(after).toBe(1);
  });
});

describe('VibeIngestProcessorService — drainReceived', () => {
  it('walks every RECEIVED event in receivedAt order and processes each', async () => {
    const idA = `vw_${TAG}_drainA_${Date.now()}`;
    const idB = `vw_${TAG}_drainB_${Date.now()}`;
    const eventA = await captureEvent(makePayload(idA));
    const eventB = await captureEvent(makePayload(idB));
    createdEventIds.push(eventA, eventB);
    const queue = makeQueueStub();
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue,
      makeSettings(true),
    );

    const n = await svc.drainReceived();
    // We can process more events than we just added if another test
    // leaves rows behind, so lower-bound rather than exact.
    expect(n).toBeGreaterThanOrEqual(2);

    for (const eid of [eventA, eventB]) {
      const ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eid } });
      expect(ev.status).toBe(JobPostIngestStatus.PROCESSED);
      if (ev.jobPostId) createdJobPostIds.push(ev.jobPostId);
    }
    expect((queue.enqueue as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('VibeIngestProcessorService — kill-switch respects scanner.analysisEnabled', () => {
  it('does not touch events when analysisEnabled=false', async () => {
    const providerJobId = `vw_${TAG}_pause_${Date.now()}`;
    const eventId = await captureEvent(makePayload(providerJobId));
    createdEventIds.push(eventId);
    const queue = makeQueueStub();
    const svc = new VibeIngestProcessorService(
      prisma as unknown as PrismaService,
      queue,
      makeSettings(false),
    );
    await svc.processEvent(eventId);

    const ev = await prisma.jobPostIngestEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.status).toBe(JobPostIngestStatus.RECEIVED);
    const n = await prisma.jobPost.count({ where: { providerJobId } });
    expect(n).toBe(0);
    expect((queue.enqueue as jest.Mock)).not.toHaveBeenCalled();
  });
});
