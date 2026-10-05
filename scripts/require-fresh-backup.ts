/* eslint-disable no-console */
/**
 * Migration gate CLI.
 *
 * Exits 0 if the environment has a fresh VERIFIED backup, non-zero
 * otherwise. Called by the deploy flow BEFORE `prisma migrate deploy`
 * to make unverified-backup deploys impossible.
 *
 *   npx ts-node scripts/require-fresh-backup.ts
 *
 *   # Pre-migration mode — the current invocation must have produced
 *   # the latest VERIFIED backup:
 *   npx ts-node scripts/require-fresh-backup.ts \
 *       --pre-migration --current-run-id=<uuid>
 *
 * No `--skip-backup` option exists on purpose.
 */
import 'dotenv/config';
import { BackupStatus, PrismaClient } from '@prisma/client';

import { evaluateMigrationGate } from '../src/backups/migration-gate';

async function main() {
  const argv = process.argv.slice(2);
  const preMigration = argv.includes('--pre-migration');
  const currentRunId =
    argv.find((a) => a.startsWith('--current-run-id='))?.split('=')[1] ?? null;

  const environment = process.env.APP_ENV ?? 'unknown';
  const prisma = new PrismaClient();

  const latestVerified = await prisma.backupRun.findFirst({
    where: { status: BackupStatus.VERIFIED, environment },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, environment: true, status: true },
  });

  const result = evaluateMigrationGate({
    environment,
    now: new Date(),
    latestVerified,
    requireCurrentRun: preMigration,
    currentRunId,
  });

  if (!result.ok) {
    console.error(
      `[require-fresh-backup] REFUSED: ${result.reason}`,
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        environment,
        latestVerified: {
          id: latestVerified!.id,
          startedAt: latestVerified!.startedAt.toISOString(),
          ageHours: (
            (Date.now() - latestVerified!.startedAt.getTime()) /
            3600_000
          ).toFixed(2),
        },
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[require-fresh-backup] FAILED', (err as Error).message);
  process.exit(1);
});
