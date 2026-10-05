/* eslint-disable no-console */
/**
 * Backup retention / prune utility.
 *
 * Deletes `BackupRun` artifact + manifest B2 objects and the DB row
 * for runs older than `BACKUP_RETENTION_DAYS` (default 365). Safety:
 *
 *   - DRY-RUN by default; pass `--apply` to perform deletes.
 *   - The single most recent VERIFIED run is NEVER pruned, even if
 *     older than the window. SUCCEEDED-but-not-VERIFIED rows do not
 *     count as a safe anchor.
 *   - DAILY / PRE_MIGRATION / PRE_SEED / MANUAL all share the window.
 *   - Partial failure (one of the B2 object deletes or the DB-row
 *     delete fails) is reported per row; the script moves to the
 *     next candidate instead of aborting.
 *   - Uses the backup-only B2 credentials. The backend runtime key
 *     is not permitted here.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import B2 = require('backblaze-b2');

import { pickRunsToPrune } from '../src/backups/retention';
import { resolveBackupB2Credentials } from '../src/backups/backup-credentials';

interface PruneReport {
  mode: 'dry-run' | 'apply';
  retentionDays: number;
  cutoff: string;
  keptLatestVerified: string | null;
  candidates: number;
  rowsDeleted: number;
  partialFailures: Array<{
    id: string;
    stage: 'artifact' | 'manifest' | 'row';
    message: string;
  }>;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  const retentionDays = Number.parseInt(
    process.env.BACKUP_RETENTION_DAYS ?? '365',
    10,
  );
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error('BACKUP_RETENTION_DAYS must be a positive integer');
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const allRuns = await prisma.backupRun.findMany({
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      startedAt: true,
      status: true,
      type: true,
      artifactKey: true,
      manifestKey: true,
    },
  });

  const candidates = pickRunsToPrune(allRuns, cutoff);
  const keptVerified = allRuns
    .filter((r) => r.status === 'VERIFIED')
    .reduce<typeof allRuns[number] | null>(
      (acc, r) =>
        !acc || r.startedAt.getTime() > acc.startedAt.getTime() ? r : acc,
      null,
    );

  const report: PruneReport = {
    mode: apply ? 'apply' : 'dry-run',
    retentionDays,
    cutoff: cutoff.toISOString(),
    keptLatestVerified: keptVerified?.id ?? null,
    candidates: candidates.length,
    rowsDeleted: 0,
    partialFailures: [],
  };

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ...report,
          plannedPrune: candidates.map((c) => ({
            id: c.id,
            type: c.type,
            status: c.status,
            startedAt: c.startedAt.toISOString(),
            artifactKey: c.artifactKey,
            manifestKey: c.manifestKey,
          })),
        },
        null,
        2,
      ),
    );
    await prisma.$disconnect();
    return;
  }

  const creds = resolveBackupB2Credentials();
  const bucketId = process.env.B2_BUCKET_DB_DUMPS_ID;
  if (!bucketId) {
    throw new Error('B2_BUCKET_DB_DUMPS_ID is not set');
  }
  const b2 = new B2({ applicationKeyId: creds.keyId, applicationKey: creds.appKey });
  await b2.authorize();

  const deleteByName = async (
    name: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const { data } = await b2.listFileVersions({
        bucketId,
        startFileName: name,
        maxFileCount: 10,
      });
      const versions = data.files.filter((f) => f.fileName === name);
      for (const v of versions) {
        await b2.deleteFileVersion({ fileId: v.fileId, fileName: v.fileName });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  };

  for (const c of candidates) {
    if (c.artifactKey) {
      const r = await deleteByName(c.artifactKey);
      if (!r.ok)
        report.partialFailures.push({ id: c.id, stage: 'artifact', message: r.message });
    }
    if (c.manifestKey) {
      const r = await deleteByName(c.manifestKey);
      if (!r.ok)
        report.partialFailures.push({ id: c.id, stage: 'manifest', message: r.message });
    }
    try {
      await prisma.backupRun.delete({ where: { id: c.id } });
      report.rowsDeleted++;
    } catch (err) {
      report.partialFailures.push({
        id: c.id,
        stage: 'row',
        message: (err as Error).message,
      });
    }
  }

  await prisma.$disconnect();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[prune-backups] FAILED', (err as Error).message);
  process.exit(1);
});
