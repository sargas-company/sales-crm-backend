#!/usr/bin/env ts-node
/**
 * Phase A — one-shot backfill for the normalised columns added to
 * `JobPost`. Reads `rawPayload` from every row whose normalised
 * fields are still NULL, runs it through the same `mapVibeJobPayload`
 * the live ingestion uses, and writes the extracted values back.
 *
 * Defaults to DRY-RUN. Pass `--apply` to actually write. Writes NOTHING
 * to a production database — the script refuses to run unless
 * `scripts/assert-local-db.ts` passes.
 *
 *   npx ts-node scripts/backfill-job-post-normalised.ts            # dry run, local only
 *   npx ts-node scripts/backfill-job-post-normalised.ts --apply    # local write
 *
 * The script is idempotent: a row already carrying a normalised
 * value is skipped. Running it twice is safe. Running it on prod is
 * NOT supported from this file — a prod-side backfill belongs with
 * the migration deploy, under the usual backup + review procedure.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { mapVibeJobPayload } from '../src/webhooks/vibe-worker/vibe-ingest-mapper';

/** Minimal env guard: refuse to run against anything that's not the
 * local docker DB. Mirrors scripts/assert-local-db.ts's checks. */
function assertLocalDbEnv(): void {
  if (process.env.APP_ENV !== 'local') {
    throw new Error(`APP_ENV must be "local" (got "${process.env.APP_ENV}")`);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`host must be localhost (got "${host}")`);
  }
  if (parsed.port !== '5433') {
    throw new Error(`port must be 5433 (got "${parsed.port}")`);
  }
  if (parsed.pathname.replace(/^\//, '') !== 'ai_dashboard') {
    throw new Error(`db must be ai_dashboard (got "${parsed.pathname}")`);
  }
}

const BATCH = 200;

type Normalised = NonNullable<ReturnType<typeof mapVibeJobPayload>>;

async function main() {
  assertLocalDbEnv();

  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  let touched = 0;
  let skipped = 0;
  let examined = 0;
  let cursor: string | undefined;
  try {
    while (true) {
      const rows: Array<{
        id: string;
        rawPayload: Prisma.JsonValue;
        budgetType: string | null;
      }> = await prisma.jobPost.findMany({
        where: {
          budgetType: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true, rawPayload: true, budgetType: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      for (const row of rows) {
        examined += 1;
        const mapped = mapVibeJobPayload(row.rawPayload);
        if (!mapped) {
          skipped += 1;
          continue;
        }
        const data = normalisedPatch(mapped);
        if (apply) {
          await prisma.jobPost.update({ where: { id: row.id }, data });
        }
        touched += 1;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[backfill] examined=${examined} touched=${touched} skipped=${skipped} (${apply ? 'applied' : 'dry-run'})`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[backfill] done: examined=${examined} touched=${touched} skipped=${skipped} (${apply ? 'applied' : 'dry-run'})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

function normalisedPatch(mapped: Normalised): Prisma.JobPostUpdateInput {
  return {
    budgetType: mapped.budgetType,
    budgetMin: mapped.budgetMin,
    budgetMax: mapped.budgetMax,
    budgetCurrency: mapped.budgetCurrency,
    postedAt: mapped.postedAt,
    contractType: mapped.contractType,
    duration: mapped.duration,
    hoursPerWeek: mapped.hoursPerWeek,
    experienceLevel: mapped.experienceLevel,
    connectsRequired: mapped.connectsRequired,
    categories: mapped.categories,
    questions:
      mapped.questions == null
        ? Prisma.DbNull
        : (mapped.questions as Prisma.InputJsonValue),
    country: mapped.country,
    city: mapped.city,
    clientPaymentVerified: mapped.clientPaymentVerified,
    clientRating: mapped.clientRating,
    clientHires: mapped.clientHires,
    clientJobsPosted: mapped.clientJobsPosted,
    clientReviewCount: mapped.clientReviewCount,
    clientRankLabel: mapped.clientRankLabel,
    clientRankScore: mapped.clientRankScore,
    clientLocationRestriction: mapped.clientLocationRestriction,
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill] FAILED:', err);
  process.exit(1);
});
