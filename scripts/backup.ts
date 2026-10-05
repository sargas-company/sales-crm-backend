/* eslint-disable no-console */
import 'dotenv/config';
import { BackupType, PrismaClient } from '@prisma/client';

import { runBackup } from '../src/backups/backup-runner';

/**
 * CLI wrapper around the shared backup runner. Default type is MANUAL.
 *   npx ts-node scripts/backup.ts
 *   BACKUP_TYPE=DAILY  BACKUP_TRIGGER=cron    npx ts-node scripts/backup.ts
 *   BACKUP_TYPE=PRE_MIGRATION BACKUP_TRIGGER=deploy npx ts-node scripts/backup.ts
 *
 * The runner creates / updates `BackupRun`, uploads + verifies the
 * artifact, and emits Discord notifications. This file is intentionally
 * a thin shell so the same path is exercised by tests.
 */
async function main() {
  const prisma = new PrismaClient();
  const type = (process.env.BACKUP_TYPE as BackupType) ?? BackupType.MANUAL;
  const triggeredBy = process.env.BACKUP_TRIGGER ?? 'cli';
  try {
    const result = await runBackup({ type, triggeredBy, prisma });
    console.log(
      JSON.stringify(
        {
          ok: true,
          id: result.run.id,
          status: result.run.status,
          artifactKey: result.manifest.artifactKey,
          size: result.manifest.size,
          checksum: result.manifest.checksum,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('[backup] failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
