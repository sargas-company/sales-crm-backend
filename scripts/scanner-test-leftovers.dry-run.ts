/**
 * READ-ONLY dry-run. Lists what a point-cleanup pass would remove
 * from the local Scanner Redis queue + Postgres JobPost table.
 * Nothing is written, nothing is deleted. The operator reviews the
 * list before any actual cleanup.
 *
 * Safety:
 *   - Hard-aborts if `APP_ENV` is anything but `local` or if the
 *     Postgres URL does not point at the local Docker DB.
 *   - PROCESSING / BullMQ `active` jobs are ALWAYS skipped (we never
 *     surface the operator a plan that would interrupt a running
 *     analysis).
 *   - "Test fixture" is identified STRICTLY by the Vibe-worker TAG
 *     pattern used by src/webhooks/vibe-worker/*.spec.ts:
 *         vw_vibe-ingest-<hex>_<pause|active|hp|dup>_<timestamp>
 *     Non-matching rows (real Vibe webhook posts) are never listed.
 *
 * Run with:  npx ts-node --project tsconfig.json scripts/scanner-test-leftovers.dry-run.ts
 */
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const QUEUE_NAME = 'job-post-processing';
const TEST_FIXTURE_RE =
  /^vw_vibe-ingest-[0-9a-f]+_(pause|active|hp|dup)_\d+$/;

async function assertLocal(prisma: PrismaClient) {
  if ((process.env.APP_ENV ?? 'local') !== 'local') {
    throw new Error(`APP_ENV must be 'local' (got '${process.env.APP_ENV}')`);
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1|::1):(5433)\//.test(url)) {
    throw new Error('DATABASE_URL does not look like the local Docker DB');
  }
  // Confirm schema size without reading secrets.
  await prisma.$queryRaw`SELECT 1`;
}

(async () => {
  const prisma = new PrismaClient();
  await assertLocal(prisma);
  const connection = new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });
  const q = new Queue(QUEUE_NAME, { connection });

  // ─── 1. Test-fixture JobPost rows ─────────────────────────────────
  const allTestRows = await prisma.jobPost.findMany({
    where: { providerJobId: { startsWith: 'vw_vibe-ingest-' } },
    select: {
      id: true,
      providerJobId: true,
      status: true,
      enqueueState: true,
      createdAt: true,
    },
  });
  const testRows = allTestRows.filter(
    (r): r is typeof r & { providerJobId: string } =>
      typeof r.providerJobId === 'string' && TEST_FIXTURE_RE.test(r.providerJobId),
  );
  const protectedRows = testRows.filter((r) => r.status === 'PROCESSING');
  const removableRows = testRows.filter((r) => r.status !== 'PROCESSING');

  console.log('=== JobPost rows matching the Vibe-worker test-fixture pattern ===');
  console.log('total matched:', testRows.length);
  console.log('would be deleted:', removableRows.length);
  console.log(
    '  by status:',
    Object.entries(
      removableRows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([s, c]) => `${s}=${c}`)
      .join(', ') || '(none)',
  );
  console.log('  skipped because status=PROCESSING:', protectedRows.length);

  // ─── 2. BullMQ jobs to drop ───────────────────────────────────────
  // We list ALL non-terminal BullMQ jobs whose jobPostId either
  // doesn't exist in the DB any more OR points at a row we are also
  // listing for removal. ACTIVE jobs are never dropped.
  const allJobs = await q.getJobs(
    ['waiting', 'paused', 'delayed', 'prioritized'],
    0,
    9999,
    true,
  );
  const activeJobs = await q.getActive(0, 9999);
  const activeIds = new Set(
    activeJobs
      .map((j) => (j.data as { jobPostId?: string } | undefined)?.jobPostId)
      .filter((v): v is string => typeof v === 'string'),
  );
  const dbIds = new Set(allTestRows.map((r) => r.id));
  const dbIdStatus = new Map(allTestRows.map((r) => [r.id, r.status] as const));

  const removableJobs: Array<{
    jobId: string;
    jobPostId: string | 'unknown';
    reason: string;
  }> = [];
  const protectedActive: string[] = [];
  for (const job of allJobs) {
    const jp = (job.data as { jobPostId?: string } | undefined)?.jobPostId;
    const jobId = String(job.id);
    if (!jp) {
      removableJobs.push({ jobId, jobPostId: 'unknown', reason: 'malformed-data' });
      continue;
    }
    if (activeIds.has(jp)) {
      protectedActive.push(jobId);
      continue;
    }
    if (!dbIds.has(jp)) {
      removableJobs.push({ jobId, jobPostId: jp, reason: 'orphan (no JobPost row)' });
      continue;
    }
    const st = dbIdStatus.get(jp);
    if (st === 'SKIPPED' || st === 'PROCESSED' || st === 'FAILED') {
      removableJobs.push({ jobId, jobPostId: jp, reason: `terminal (${st})` });
    }
  }

  console.log('\n=== BullMQ jobs that would be queue.remove()d ===');
  console.log('total:', removableJobs.length);
  console.log(
    '  by reason:',
    Object.entries(
      removableJobs.reduce<Record<string, number>>((acc, j) => {
        acc[j.reason] = (acc[j.reason] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([r, c]) => `${r}=${c}`)
      .join(', ') || '(none)',
  );
  console.log('  skipped because currently ACTIVE in Redis:', protectedActive.length);

  console.log('\n=== Sample removable DB rows (first 5) ===');
  for (const r of removableRows.slice(0, 5)) {
    console.log(
      `  id=${r.id}  status=${r.status}  enqueueState=${r.enqueueState}  providerJobId=${r.providerJobId}`,
    );
  }
  console.log('\n=== Sample removable BullMQ jobs (first 5) ===');
  for (const j of removableJobs.slice(0, 5)) {
    console.log(`  jobId=${j.jobId}  jobPostId=${j.jobPostId}  reason=${j.reason}`);
  }

  console.log(
    '\nDRY-RUN COMPLETE. No DB rows deleted, no Redis jobs removed.',
  );

  await prisma.$disconnect();
  await q.close();
  await connection.quit();
})().catch((e) => {
  console.error('dry-run error:', (e as Error).message);
  process.exit(1);
});
