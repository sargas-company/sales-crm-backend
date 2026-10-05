/* eslint-disable no-console */
/**
 * Watchdog for stuck `BackupRun` rows.
 *
 * A `pg_dump` crash or a hard kill can leave a row in `RUNNING`
 * forever: the main runner never updates the status in that case. This
 * script finds every `RUNNING` row older than `STUCK_HOURS` (default
 * 2 h), flips it to `FAILED` with a safe reason and fires a Discord
 * failure notification per row.
 *
 * Dry-run by default. The `--apply` flag persists the changes.
 *
 *   npx ts-node scripts/mark-stuck-running.ts            # dry-run
 *   npx ts-node scripts/mark-stuck-running.ts --apply    # perform
 */
import 'dotenv/config';
import { BackupStatus, PrismaClient } from '@prisma/client';

import { notifyDiscord, resolveOpsWebhook } from '../src/backups/discord-notify';

const DEFAULT_STUCK_HOURS = 2;

async function main() {
  const apply = process.argv.includes('--apply');
  const stuckHours = Number.parseFloat(
    process.env.STUCK_HOURS ?? String(DEFAULT_STUCK_HOURS),
  );
  const cutoff = new Date(Date.now() - stuckHours * 60 * 60 * 1000);

  const prisma = new PrismaClient();
  const stuck = await prisma.backupRun.findMany({
    where: { status: BackupStatus.RUNNING, startedAt: { lt: cutoff } },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      type: true,
      environment: true,
      startedAt: true,
      triggeredBy: true,
    },
  });

  console.log(
    `[mark-stuck-running] stuckHours=${stuckHours} cutoff=${cutoff.toISOString()} candidates=${stuck.length}`,
  );

  if (!apply) {
    console.log(
      JSON.stringify(
        { mode: 'dry-run', wouldMarkFailed: stuck.length, rows: stuck },
        null,
        2,
      ),
    );
    await prisma.$disconnect();
    return;
  }

  const webhook = resolveOpsWebhook();
  let marked = 0;
  for (const row of stuck) {
    const safeReason = `BackupRun ${row.id} stuck in RUNNING for ${stuckHours}h+ since ${row.startedAt.toISOString()}; marked FAILED by watchdog`;
    try {
      await prisma.backupRun.update({
        where: { id: row.id },
        data: {
          status: BackupStatus.FAILED,
          completedAt: new Date(),
          errorMessage: safeReason.slice(0, 500),
        },
      });
      marked++;
      await notifyDiscord({
        outcome: 'failure',
        type: row.type,
        environment: row.environment,
        message: safeReason,
        webhook,
      });
    } catch (err) {
      console.error(
        `[mark-stuck-running] could not update ${row.id}: ${
          (err as Error).message
        }`,
      );
    }
  }

  await prisma.$disconnect();
  console.log(
    JSON.stringify(
      { mode: 'apply', candidates: stuck.length, markedFailed: marked },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[mark-stuck-running] FAILED', (err as Error).message);
  process.exit(1);
});
