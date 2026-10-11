/**
 * Shared factory for Prisma + BullMQ clients used by integration
 * specs. Every spec that previously did `new PrismaClient()` must
 * route through here. The factory:
 *   - Reads the already-overridden `DATABASE_URL` (the Jest setupFiles
 *     hook replaces it with `TEST_DATABASE_URL`) and refuses to
 *     build a client if that override did NOT happen.
 *   - Reads `BULLMQ_PREFIX` and applies it to every Queue it
 *     builds, so test queues never collide with the user's local
 *     or production queues even on the same Redis instance.
 *   - Exposes small helpers (`truncateScannerTables`, `clearQueue`)
 *     for teardown of state created INSIDE service calls — those
 *     rows can't be tracked by per-test id lists.
 *
 * This file is only reachable from spec code. Production imports
 * must NOT depend on it.
 */
import { PrismaClient } from '@prisma/client';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

export function getTestPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url || !/_test(\?|$)/.test(url)) {
    throw new Error(
      '[test-clients] DATABASE_URL does not end with `_test` — jest-setup-isolation did not run. ' +
        'Run jest via the standard `npm test` script or ensure the setup hook is active.',
    );
  }
  return new PrismaClient();
}

export function getTestRedisConnection(): IORedis {
  return new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });
}

export function getTestPrefix(): string {
  const p = process.env.BULLMQ_PREFIX;
  if (!p) {
    throw new Error(
      '[test-clients] BULLMQ_PREFIX is empty — jest-setup-isolation did not run.',
    );
  }
  return p;
}

export function buildTestQueue(name: string, connection: IORedis): Queue {
  return new Queue(name, { connection, prefix: getTestPrefix() });
}

export function buildTestQueueEvents(name: string, connection: IORedis): QueueEvents {
  return new QueueEvents(name, { connection, prefix: getTestPrefix() });
}

/**
 * Drains BOTH Scanner-related tables that specs touch via service
 * methods, so no rows leak between test files that share the
 * worker's test DB.
 */
export async function truncateScannerTables(prisma: PrismaClient): Promise<void> {
  // TRUNCATE … RESTART IDENTITY CASCADE wipes the two Scanner tables
  // without touching user tables (Users / Settings / etc.). The
  // CASCADE is intentional: JobPostIngestEvent has a FK to JobPost
  // via `jobPostId`, so a JobPost truncate without CASCADE would
  // fail if any ingest rows remain.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "JobPostIngestEvent", "JobPost" RESTART IDENTITY CASCADE',
  );
}

/**
 * Drops every Setting override added during a test, so a spec that
 * flipped `scanner.analysisEnabled` doesn't leave the next spec
 * seeing a surprise value.
 */
export async function resetTestSettings(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "SettingValue" RESTART IDENTITY CASCADE');
}

/**
 * Removes every BullMQ job stored under the test prefix. Idempotent
 * — safe to call before AND after a run.
 *
 * Hard safety: refuses to call `obliterate` on a queue whose
 * effective prefix is not a `bull-test-*` namespace. This stops a
 * misconfigured spec from blowing away the user's local queue
 * (`bull:`) or any production/staging queue.
 */
export async function clearTestQueue(queue: Queue): Promise<void> {
  // BullMQ v5 keeps the prefix on `queue.opts.prefix`; it defaults
  // to `bull` when the Queue was built without one. We require an
  // explicit test prefix.
  const effectivePrefix =
    (queue.opts as { prefix?: string } | undefined)?.prefix ?? 'bull';
  if (!/^bull-test-/.test(effectivePrefix)) {
    throw new Error(
      `[test-clients] refuse to clear queue with prefix "${effectivePrefix}" ` +
        '— only `bull-test-*` namespaces may be obliterated by tests.',
    );
  }
  await queue.obliterate({ force: true }).catch(() => undefined);
}
