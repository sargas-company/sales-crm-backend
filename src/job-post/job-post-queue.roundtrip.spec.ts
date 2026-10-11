/**
 * Real BullMQ + local Redis roundtrip for `JobPostQueueService.enqueue`.
 *
 * Verifies the Phase A outbox contract against the actual broker:
 *   - deterministic `jobId` is `${jobPostId}-v1` and uses a hyphen,
 *     not a colon (so Bull Board / tooling stay happy);
 *   - the second enqueue for the same JobPost is a no-op in Redis
 *     (idempotent handoff);
 *   - DB row flips `enqueueState: PENDING → ENQUEUED` only after
 *     Redis acknowledges the add.
 *
 * The test is skipped when a local Redis is not reachable, so a
 * cold-clone of the repo still runs the broader suite.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { JOB_POST_PROCESS, JOB_POST_QUEUE } from './job-post.constants';
import { JobPostQueueService } from './job-post-queue.service';
import {
  buildTestQueue,
  clearTestQueue,
  getTestPrefix,
  getTestPrisma,
  truncateScannerTables,
} from '../testing/test-clients';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
// Unique queue name per run so parallel runs can't collide.
const TEST_QUEUE_NAME = `${JOB_POST_QUEUE}__test_${randomUUID().slice(0, 8)}`;

let redisAvailable = false;
let probeConn: IORedis | null = null;

async function probeRedis(): Promise<boolean> {
  try {
    probeConn = new IORedis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // bail out immediately
    });
    await probeConn.connect();
    const pong = await probeConn.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

const prisma = getTestPrisma();
let svc: JobPostQueueService;
let probeQueue: Queue | null = null;
const createdJobPostIds: string[] = [];

let testConnection: IORedis | null = null;

beforeAll(async () => {
  redisAvailable = await probeRedis();
  if (!redisAvailable) return;

  // Build the service by hand: skip `onModuleInit` (which would
  // open an extra Queue + IORedis pair under the test prefix we'd
  // then have to track). Instead, wire a single test-only Redis
  // connection + queue (both built via buildTestQueue, which applies
  // `BULLMQ_PREFIX`) directly into the service fields.
  const config = {
    get: (k: string, def?: unknown) => {
      if (k === 'REDIS_HOST') return REDIS_HOST;
      if (k === 'REDIS_PORT') return REDIS_PORT;
      return def;
    },
  } as unknown as ConfigService;
  svc = new JobPostQueueService(config, prisma as unknown as PrismaService);
  testConnection = new IORedis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
  });
  const testQueue = buildTestQueue(TEST_QUEUE_NAME, testConnection);
  // Sanity: the Queue MUST be under the test prefix, otherwise this
  // spec would be writing to the user's `bull:` namespace.
  const effectivePrefix = (testQueue.opts as { prefix?: string }).prefix;
  if (effectivePrefix !== getTestPrefix()) {
    throw new Error(
      `[roundtrip] test queue built with prefix "${effectivePrefix}", expected "${getTestPrefix()}"`,
    );
  }
  (svc as unknown as { connection: IORedis; queue: Queue }).connection =
    testConnection;
  (svc as unknown as { connection: IORedis; queue: Queue }).queue = testQueue;
  probeQueue = testQueue;

  // Fresh test DB — truncate Scanner tables up front.
  await truncateScannerTables(prisma);
});

afterEach(async () => {
  if (!redisAvailable) return;
  // Drain is prefix-local — only touches the test namespace jobs
  // registered under this Queue instance.
  await probeQueue?.drain(true).catch(() => undefined);
});

afterAll(async () => {
  await truncateScannerTables(prisma).catch(() => undefined);
  await prisma.$disconnect();
  if (probeQueue) {
    // `clearTestQueue` refuses to run if the prefix isn't bull-test-*.
    await clearTestQueue(probeQueue);
    await probeQueue.close().catch(() => undefined);
  }
  if (testConnection) {
    await testConnection.quit().catch(() => undefined);
  }
  if (probeConn) {
    await probeConn.quit().catch(() => undefined);
  }
});

async function makeJobPost(providerId: string): Promise<string> {
  const row = await prisma.jobPost.create({
    data: {
      providerJobId: providerId,
      rawText: 'roundtrip-test',
      rawPayload: {} as never,
      status: 'NEW',
      enqueueState: 'PENDING',
      scanner: 'vibe-worker',
      hSkillsKeywords: [],
    },
    select: { id: true },
  });
  createdJobPostIds.push(row.id);
  return row.id;
}

describe('JobPostQueueService.enqueue — real BullMQ + Redis', () => {
  // Guard: skip gracefully when Redis isn't up locally. The test
  // isn't the kind we want to force people to boot docker for.
  const skipIfNoRedis = (name: string, body: () => Promise<void>) => {
    it(name, async () => {
      if (!redisAvailable) {
        // eslint-disable-next-line no-console
        console.warn(
          `[job-post-queue.roundtrip] Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}; skipping.`,
        );
        return;
      }
      await body();
    });
  };

  skipIfNoRedis('uses hyphen-separated jobId and marks ENQUEUED after success', async () => {
    const id = await makeJobPost(`rt_${randomUUID().slice(0, 8)}`);
    await svc.enqueue(id);
    const job = await probeQueue!.getJob(`${id}-v1`);
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_POST_PROCESS);
    const row = await prisma.jobPost.findUniqueOrThrow({ where: { id } });
    expect(row.enqueueState).toBe('ENQUEUED');
    expect(row.enqueuedAt).not.toBeNull();
  });

  skipIfNoRedis('a second enqueue is a no-op (idempotent by deterministic jobId)', async () => {
    const id = await makeJobPost(`rt_${randomUUID().slice(0, 8)}`);
    await svc.enqueue(id);
    await svc.enqueue(id);
    const waiting = await probeQueue!.getJobCountByTypes('waiting');
    const delayed = await probeQueue!.getJobCountByTypes('delayed');
    const active = await probeQueue!.getJobCountByTypes('active');
    // Exactly one BullMQ job for this JobPost across the typical
    // "pending-work" states.
    expect(waiting + delayed + active).toBe(1);
  });

  skipIfNoRedis('jobId contains hyphen, never colon', async () => {
    const id = await makeJobPost(`rt_${randomUUID().slice(0, 8)}`);
    await svc.enqueue(id);
    const job = await probeQueue!.getJob(`${id}-v1`);
    expect(job).toBeDefined();
    expect(job!.id).toMatch(/-v1$/);
    expect(job!.id).not.toMatch(/:/);
  });
});
