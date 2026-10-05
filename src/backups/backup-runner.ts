/* eslint-disable no-console */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import B2 = require('backblaze-b2');
import {
  BackupStatus,
  BackupType,
  PrismaClient,
  type BackupRun,
} from '@prisma/client';

import { resolveBackupB2Credentials } from './backup-credentials';
import { notifyDiscord, resolveOpsWebhook } from './discord-notify';

/**
 * Advisory-lock key reserved for the whole-DB backup operation. The
 * value is arbitrary but stable — all backup runners agree on it so
 * `pg_try_advisory_lock` on this key gates every concurrent attempt.
 */
const BACKUP_LOCK_KEY = 7749102301;

export interface BackupRunnerOptions {
  type: BackupType;
  /** Freeform trigger label — e.g. "cron" / "pre-migration" / "cli:<user>". */
  triggeredBy?: string;
  /** Override `APP_ENV` reporting; defaults to `process.env.APP_ENV`. */
  environment?: string;
  env?: NodeJS.ProcessEnv;
  /** Logger — defaults to console.log/error. Tests pass a sink. */
  logger?: { log: (m: string) => void; error: (m: string) => void };
  /** Prisma client to use. Scripts build their own; tests inject a mock. */
  prisma: PrismaClient;
}

export interface BackupManifest {
  backupRunId: string;
  type: BackupType;
  environment: string;
  createdAt: string;
  databaseName: string;
  pgServerVersion: string | null;
  pgDumpClientVersion: string | null;
  gitSha: string | null;
  migrationName: string | null;
  artifactKey: string;
  size: number;
  checksum: string;
  checksumAlgo: 'sha256';
}

export interface BackupResult {
  run: BackupRun;
  manifest: BackupManifest;
}

type Deps = {
  pgDump: typeof runPgDump;
  pgRestoreList: typeof runPgRestoreList;
  pgServerVersion: typeof getPgServerVersion;
  pgDumpClientVersion: typeof getPgDumpClientVersion;
  lastMigrationName: typeof getLastMigrationName;
  tryAcquireLock: typeof tryAcquireLock;
  releaseLock: typeof releaseLock;
  b2Factory: (keyId: string, appKey: string) => B2;
};

const defaultDeps: Deps = {
  pgDump: runPgDump,
  pgRestoreList: runPgRestoreList,
  pgServerVersion: getPgServerVersion,
  pgDumpClientVersion: getPgDumpClientVersion,
  lastMigrationName: getLastMigrationName,
  tryAcquireLock,
  releaseLock,
  b2Factory: (keyId, appKey) =>
    new B2({ applicationKeyId: keyId, applicationKey: appKey }),
};

/**
 * Run a complete, verified backup. The exported function is used by
 * `scripts/backup.ts` and by the integration tests; both paths share
 * the same transitions so VERIFIED can never be reached without the
 * full round-trip succeeding.
 */
export async function runBackup(
  options: BackupRunnerOptions,
  depsOverride: Partial<Deps> = {},
): Promise<BackupResult> {
  const deps: Deps = { ...defaultDeps, ...depsOverride };
  const env = options.env ?? process.env;
  const log = options.logger ?? console;
  const environment = options.environment ?? env.APP_ENV ?? 'unknown';
  const triggeredBy = options.triggeredBy ?? 'cli';

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const parsedDb = parseDatabaseUrl(databaseUrl);

  const creds = resolveBackupB2Credentials(env);
  const bucketId = env.B2_BUCKET_DB_DUMPS_ID;
  const bucketName = env.B2_BUCKET_DB_DUMPS_NAME;
  if (!bucketId || !bucketName) {
    throw new Error(
      'B2_BUCKET_DB_DUMPS_ID / B2_BUCKET_DB_DUMPS_NAME are not set',
    );
  }

  const lockAcquired = await deps.tryAcquireLock(options.prisma);
  if (!lockAcquired) {
    const msg = 'Another backup is already running (pg advisory lock held)';
    await notifyDiscord({
      outcome: 'failure',
      type: options.type,
      environment,
      message: msg,
      webhook: resolveOpsWebhook(env),
    });
    throw new Error(msg);
  }

  const scratchDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'sargas-backup-'),
  );
  const dumpPath = path.join(scratchDir, 'dump.pgdump');
  const verifyPath = path.join(scratchDir, 'dump.verify.pgdump');

  let run: BackupRun | null = null;
  try {
    const startedAt = new Date();
    run = await options.prisma.backupRun.create({
      data: {
        type: options.type,
        status: BackupStatus.RUNNING,
        environment,
        databaseName: parsedDb.database,
        startedAt,
        gitSha: (env.GIT_SHA ?? '').slice(0, 40) || null,
        triggeredBy,
      },
    });

    log.log(`[backup] starting ${options.type} on ${environment} → ${run.id}`);

    await deps.pgDump({
      bin: env.PG_DUMP_BIN || 'pg_dump',
      parsed: parsedDb,
      outPath: dumpPath,
    });
    const size = (await fs.promises.stat(dumpPath)).size;
    log.log(`[backup] dump size: ${(size / 1024 / 1024).toFixed(2)} MB`);

    const checksum = await sha256File(dumpPath);
    log.log(`[backup] sha256=${checksum}`);

    // Local sanity before upload — a corrupt dump must not reach B2.
    await deps.pgRestoreList({
      bin: env.PG_RESTORE_BIN || 'pg_restore',
      filePath: dumpPath,
    });

    const pgServerVersion = await deps.pgServerVersion(parsedDb, env);
    const pgDumpClientVersion = await deps.pgDumpClientVersion(
      env.PG_DUMP_BIN || 'pg_dump',
    );
    const migrationName = await deps.lastMigrationName(options.prisma);

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const prefix = options.type.toLowerCase().replace(/_/g, '-');
    const base = `${prefix}/${yyyy}-${mm}-${dd}_${hh}${mi}_${checksum.slice(0, 10)}`;
    const artifactKey = `${base}.dump`;
    const manifestKey = `${base}.manifest.json`;

    const manifest: BackupManifest = {
      backupRunId: run.id,
      type: options.type,
      environment,
      createdAt: now.toISOString(),
      databaseName: parsedDb.database,
      pgServerVersion,
      pgDumpClientVersion,
      gitSha: run.gitSha,
      migrationName,
      artifactKey,
      size,
      checksum,
      checksumAlgo: 'sha256',
    };

    const b2 = deps.b2Factory(creds.keyId, creds.appKey);
    await b2.authorize();
    // Artifact upload.
    const artifactBuf = await fs.promises.readFile(dumpPath);
    const { data: upA } = await b2.getUploadUrl({ bucketId });
    await b2.uploadFile({
      uploadUrl: upA.uploadUrl,
      uploadAuthToken: upA.authorizationToken,
      fileName: artifactKey,
      data: artifactBuf,
      mime: 'application/octet-stream',
      contentLength: artifactBuf.length,
    });
    // Manifest upload.
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const { data: upM } = await b2.getUploadUrl({ bucketId });
    await b2.uploadFile({
      uploadUrl: upM.uploadUrl,
      uploadAuthToken: upM.authorizationToken,
      fileName: manifestKey,
      data: manifestBuf,
      mime: 'application/json',
      contentLength: manifestBuf.length,
    });

    // Verification round-trip: download the artifact we just uploaded,
    // re-hash, and run pg_restore --list on the downloaded copy. ONLY
    // after both checks pass do we mark VERIFIED.
    log.log(`[backup] verifying round-trip from ${artifactKey}...`);
    const dlResp = await (b2 as unknown as {
      downloadFileByName: (args: {
        bucketName: string;
        fileName: string;
        responseType?: string;
      }) => Promise<{ data: ArrayBuffer }>;
    }).downloadFileByName({
      bucketName,
      fileName: artifactKey,
      responseType: 'arraybuffer',
    });
    await fs.promises.writeFile(verifyPath, Buffer.from(dlResp.data));
    const roundTripChecksum = await sha256File(verifyPath);
    if (roundTripChecksum !== checksum) {
      throw new Error(
        `Checksum mismatch after round-trip: local ${checksum} vs downloaded ${roundTripChecksum}`,
      );
    }
    await deps.pgRestoreList({
      bin: env.PG_RESTORE_BIN || 'pg_restore',
      filePath: verifyPath,
    });

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const verified = await options.prisma.backupRun.update({
      where: { id: run.id },
      data: {
        status: BackupStatus.VERIFIED,
        completedAt,
        durationMs,
        artifactKey,
        manifestKey,
        size: BigInt(size),
        checksum,
        checksumAlgo: 'sha256',
        pgVersion: pgServerVersion,
        migrationName,
        lastVerifiedAt: completedAt,
      },
    });

    log.log(`[backup] VERIFIED ${artifactKey}`);
    await notifyDiscord({
      outcome: 'success',
      type: options.type,
      environment,
      message: `${artifactKey} (${(size / 1024 / 1024).toFixed(2)} MB)`,
      webhook: resolveOpsWebhook(env),
    });

    return { run: verified, manifest };
  } catch (err) {
    const safe = sanitiseError(err);
    log.error(`[backup] FAILED: ${safe}`);
    if (run) {
      try {
        await options.prisma.backupRun.update({
          where: { id: run.id },
          data: {
            status: BackupStatus.FAILED,
            completedAt: new Date(),
            errorMessage: safe.slice(0, 500),
          },
        });
      } catch (dbErr) {
        log.error(
          `[backup] could not persist FAILED state: ${(dbErr as Error).message}`,
        );
      }
    }
    await notifyDiscord({
      outcome: 'failure',
      type: options.type,
      environment,
      message: safe,
      webhook: resolveOpsWebhook(env),
    });
    throw err;
  } finally {
    try {
      await deps.releaseLock(options.prisma);
    } catch (relErr) {
      log.error(`[backup] lock release failed: ${(relErr as Error).message}`);
    }
    await cleanupDir(scratchDir).catch(() => undefined);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

export interface ParsedDbUrl {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
}

export function parseDatabaseUrl(raw: string): ParsedDbUrl {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/**
 * `pg_dump` is run with argv-list args — no shell interpolation —
 * and its stdout is piped straight to a file so the dump never has
 * to fit in Node's heap. `PGPASSWORD` is passed via env.
 */
export async function runPgDump(args: {
  bin: string;
  parsed: ParsedDbUrl;
  outPath: string;
}): Promise<void> {
  const { bin, parsed, outPath } = args;
  const argv = [
    '-h', parsed.host,
    '-p', parsed.port,
    '-U', parsed.user,
    '-d', parsed.database,
    '-Fc',
    '--no-owner',
    '--no-acl',
  ];
  return new Promise((resolve, reject) => {
    const sink = fs.createWriteStream(outPath);
    const child = spawn(bin, argv, {
      env: { ...process.env, PGPASSWORD: parsed.password },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.pipe(sink);
    child.on('error', (err) => reject(err));
    sink.on('error', (err) => reject(err));
    child.on('close', (code) => {
      sink.end(() => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `pg_dump exited ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`,
            ),
          );
      });
    });
  });
}

/** `pg_restore --list` as a sanity check that the dump is a readable Fc archive. */
export async function runPgRestoreList(args: {
  bin: string;
  filePath: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.bin, ['-l', args.filePath]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // We don't care about stdout — just the exit code.
    child.stdout.on('data', () => undefined);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `pg_restore --list exited ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`,
          ),
        );
    });
  });
}

async function getPgServerVersion(
  parsed: ParsedDbUrl,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = env.PSQL_BIN || 'psql';
    const argv = [
      '-h', parsed.host,
      '-p', parsed.port,
      '-U', parsed.user,
      '-d', parsed.database,
      '-tA',
      '-c', 'SHOW server_version',
    ];
    const child = spawn(bin, argv, {
      env: { ...process.env, PGPASSWORD: parsed.password },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
  });
}

async function getPgDumpClientVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version']);
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
  });
}

async function getLastMigrationName(
  prisma: PrismaClient,
): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

async function tryAcquireLock(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ pg_try_advisory_lock: boolean }>>`
    SELECT pg_try_advisory_lock(${BACKUP_LOCK_KEY}) AS pg_try_advisory_lock
  `;
  return rows[0]?.pg_try_advisory_lock === true;
}

async function releaseLock(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT pg_advisory_unlock(${BACKUP_LOCK_KEY})`;
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function cleanupDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** Produce an error message safe to log: hide anything shaped like a connection string. */
export function sanitiseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://<redacted>')
    .replace(/PGPASSWORD=\S+/gi, 'PGPASSWORD=<redacted>')
    .replace(/[A-Z0-9]{20,}/g, '<redacted-token>')
    .slice(0, 1500);
}
