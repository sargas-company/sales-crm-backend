/* eslint-disable no-console */
/**
 * Scratch restore utility.
 *
 * Default run: verifies that a backup is restorable WITHOUT touching
 * any database. With `--restore-to=<scratch DATABASE_URL>` it will
 * restore into a scratch DB on localhost only — the production DB
 * cannot be addressed by this script, period.
 *
 *   # Verify only — manifest, sha256, pg_restore --list.
 *   npx ts-node scripts/restore.ts --backup-id=<uuid>
 *
 *   # Scratch restore into a local DB whose name contains
 *   # `_restore_` or `_scratch`. Target DB must already exist and
 *   # be empty (DROP ... IS NOT ALLOWED here).
 *   npx ts-node scripts/restore.ts --backup-id=<uuid> \
 *     --restore-to=postgres://user:pw@localhost:5433/ai_dashboard_restore_demo \
 *     --confirm=ai_dashboard_restore_demo
 *
 * There is NO `--replace` and NO ability to point at the production
 * database — those will be added in a separate pass after the
 * production topology is confirmed.
 */
import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  AuditResult,
  AuditSeverity,
  BackupStatus,
  PrismaClient,
} from '@prisma/client';
import B2 = require('backblaze-b2');

import { resolveBackupB2Credentials } from '../src/backups/backup-credentials';
import {
  notifyDiscord,
  resolveOpsWebhook,
} from '../src/backups/discord-notify';
import {
  parseDatabaseUrl,
  runPgRestoreList,
  sanitiseError,
  sha256File,
} from '../src/backups/backup-runner';
import { evaluateScratchTarget } from '../src/backups/scratch-restore-guard';

interface Args {
  backupId: string;
  restoreTo: string | null;
  confirm: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
  const backupId = get('backup-id');
  if (!backupId) {
    throw new Error('--backup-id=<uuid> is required');
  }
  return {
    backupId,
    restoreTo: get('restore-to'),
    confirm: get('confirm'),
  };
}

async function main() {
  const args = parseArgs();
  const prisma = new PrismaClient();
  const env = process.env.APP_ENV ?? 'unknown';

  const run = await prisma.backupRun.findUnique({ where: { id: args.backupId } });
  if (!run) throw new Error(`BackupRun ${args.backupId} not found`);
  if (run.status !== BackupStatus.VERIFIED) {
    throw new Error(
      `BackupRun ${run.id} status is ${run.status}, expected VERIFIED; refusing to restore an unverified dump`,
    );
  }
  if (!run.artifactKey || !run.manifestKey || !run.checksum) {
    throw new Error(
      `BackupRun ${run.id} is missing artifactKey / manifestKey / checksum — nothing to restore`,
    );
  }

  const scratch = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sargas-restore-'),
  );
  const artifactPath = path.join(scratch, 'artifact.pgdump');
  const manifestPath = path.join(scratch, 'manifest.json');

  try {
    const bucketName = process.env.B2_BUCKET_DB_DUMPS_NAME;
    if (!bucketName) throw new Error('B2_BUCKET_DB_DUMPS_NAME is not set');
    const creds = resolveBackupB2Credentials();
    const b2 = new B2({ applicationKeyId: creds.keyId, applicationKey: creds.appKey });
    await b2.authorize();

    const dlArtifact = await (b2 as unknown as {
      downloadFileByName: (a: { bucketName: string; fileName: string; responseType?: string }) => Promise<{ data: ArrayBuffer }>;
    }).downloadFileByName({
      bucketName,
      fileName: run.artifactKey,
      responseType: 'arraybuffer',
    });
    await fs.promises.writeFile(artifactPath, Buffer.from(dlArtifact.data));

    const dlManifest = await (b2 as unknown as {
      downloadFileByName: (a: { bucketName: string; fileName: string; responseType?: string }) => Promise<{ data: ArrayBuffer }>;
    }).downloadFileByName({
      bucketName,
      fileName: run.manifestKey,
      responseType: 'arraybuffer',
    });
    await fs.promises.writeFile(manifestPath, Buffer.from(dlManifest.data));
    const manifest = JSON.parse(
      (await fs.promises.readFile(manifestPath, 'utf8')),
    ) as { checksum?: string; artifactKey?: string };

    // Manifest + checksum match.
    if (manifest.artifactKey !== run.artifactKey) {
      throw new Error(
        `Manifest artifactKey "${manifest.artifactKey}" does not match BackupRun ${run.id} key "${run.artifactKey}"`,
      );
    }
    const actualHash = await sha256File(artifactPath);
    if (actualHash !== run.checksum) {
      throw new Error(
        `Checksum mismatch: DB ${run.checksum} vs downloaded ${actualHash}`,
      );
    }
    if (manifest.checksum !== run.checksum) {
      throw new Error(
        `Manifest checksum does not match BackupRun.checksum`,
      );
    }

    // pg_restore --list sanity.
    await runPgRestoreList({
      bin: process.env.PG_RESTORE_BIN || 'pg_restore',
      filePath: artifactPath,
    });

    const plan = {
      backupId: run.id,
      type: run.type,
      environment: run.environment,
      artifactKey: run.artifactKey,
      size: run.size !== null ? String(run.size) : null,
      checksum: run.checksum,
      checksumVerified: true,
      pgRestoreListVerified: true,
    };

    if (!args.restoreTo) {
      console.log(
        JSON.stringify(
          {
            mode: 'verify-only',
            ok: true,
            plan,
            note: 'Pass --restore-to=<scratch DATABASE_URL> and --confirm=<db-name> to actually restore into a scratch DB. The script will refuse any non-local or non-scratch target.',
          },
          null,
          2,
        ),
      );
      return;
    }

    const guard = evaluateScratchTarget(args.restoreTo);
    if (!guard.ok) throw new Error(guard.message);
    if (!args.confirm || args.confirm !== guard.database) {
      throw new Error(
        `--confirm must match the target database name "${guard.database}" exactly`,
      );
    }

    // Scratch restore. Target is pre-existing + empty by convention —
    // we do NOT drop/create. If the target has data, pg_restore will
    // merge, which is acceptable for a scratch verify.
    const target = parseDatabaseUrl(args.restoreTo);
    await runPgRestoreInto({
      bin: process.env.PG_RESTORE_BIN || 'pg_restore',
      target,
      filePath: artifactPath,
    });

    // Smoke queries against the restored DB.
    const smoke = await runSmokeQueries(target);

    await prisma.auditEvent.create({
      data: {
        actorUserId: null,
        domain: 'SETTINGS',
        action: 'backup.scratch_restore',
        targetType: 'BackupRun',
        targetId: run.id,
        targetLabel: `scratch:${guard.database}`,
        result: AuditResult.SUCCESS,
        severity: AuditSeverity.WARNING,
        metadata: { restoredIntoDb: guard.database, smoke },
      },
    });
    await notifyDiscord({
      outcome: 'success',
      type: run.type,
      environment: env,
      message: `Scratch restore of ${run.id} into ${guard.database} ok; smoke tables=${smoke.publicTableCount}`,
      webhook: resolveOpsWebhook(),
    });

    console.log(
      JSON.stringify(
        {
          mode: 'scratch-restore',
          ok: true,
          plan,
          restoredInto: guard.database,
          smoke,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const safe = sanitiseError(err);
    try {
      await prisma.auditEvent.create({
        data: {
          actorUserId: null,
          domain: 'SETTINGS',
          action: 'backup.scratch_restore',
          targetType: 'BackupRun',
          targetId: args.backupId,
          targetLabel: 'scratch:failed',
          result: AuditResult.FAILED,
          severity: AuditSeverity.CRITICAL,
          metadata: { reason: safe },
        },
      });
    } catch {
      /* non-fatal */
    }
    await notifyDiscord({
      outcome: 'failure',
      type: run?.type ?? 'MANUAL',
      environment: env,
      message: safe,
      webhook: resolveOpsWebhook(),
    });
    console.error('[restore] FAILED:', safe);
    process.exitCode = 1;
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

async function runPgRestoreInto(args: {
  bin: string;
  target: ReturnType<typeof parseDatabaseUrl>;
  filePath: string;
}): Promise<void> {
  const { bin, target, filePath } = args;
  const argv = [
    '-h', target.host,
    '-p', target.port,
    '-U', target.user,
    '-d', target.database,
    '--no-owner',
    '--no-acl',
    '--single-transaction',
    filePath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, argv, {
      env: { ...process.env, PGPASSWORD: target.password },
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `pg_restore exited ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`,
          ),
        );
    });
  });
}

async function runSmokeQueries(target: ReturnType<typeof parseDatabaseUrl>) {
  const psql = async (sql: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const bin = process.env.PSQL_BIN || 'psql';
      const argv = [
        '-h', target.host,
        '-p', target.port,
        '-U', target.user,
        '-d', target.database,
        '-tA',
        '-c', sql,
      ];
      const child = spawn(bin, argv, {
        env: { ...process.env, PGPASSWORD: target.password },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`psql exited ${code}: ${err.slice(0, 300)}`));
      });
    });
  const publicTableCount = Number.parseInt(
    await psql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"),
    10,
  );
  const prismaMigrations = Number.parseInt(
    await psql('SELECT COUNT(*) FROM _prisma_migrations'),
    10,
  );
  const userRows = await psql('SELECT COUNT(*) FROM "User"').catch(() => 'n/a');
  return { publicTableCount, prismaMigrations, userRows };
}

// Keep createHash import useful even when unused on some branches —
// tsc otherwise flags the unused import depending on tsconfig.
void createHash;

main().catch((err) => {
  console.error('[restore] FAILED', (err as Error).message);
  process.exit(1);
});
