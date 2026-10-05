/* eslint-disable no-console */
/**
 * Production bootstrap preflight.
 *
 * Called ONCE per environment, BEFORE the first production backup
 * exists. Validates that everything the first `prisma migrate deploy`
 * + first `make backup` need is in place:
 *
 *   - APP_ENV = production;
 *   - every mandatory env variable is present (no values are printed);
 *   - DATABASE_URL points at a reachable Postgres (SELECT 1);
 *   - pg_dump binary resolves and reports major version 16.x;
 *   - prisma schema validates;
 *   - no VERIFIED backup for env=production already exists (if one
 *     does, bootstrap is already done — the operator must use
 *     `make prod-preflight` instead).
 *
 * It does NOT demand an existing VERIFIED backup. That's what
 * `scripts/require-fresh-backup.ts` enforces for every ROUTINE deploy
 * after bootstrap.
 *
 *   npx ts-node scripts/bootstrap-preflight.ts
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { BackupStatus, PrismaClient } from '@prisma/client';

const REQUIRED_ENV = [
  'APP_ENV',
  'DATABASE_URL',
  'API_PORT',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CREDENTIAL_VAULT_MASTER_KEY_V1',
  'VAULT_RP_ID',
  'VAULT_RP_ORIGIN',
  'B2_KEY_ID',
  'B2_APP_KEY',
  'B2_BACKUP_KEY_ID',
  'B2_BACKUP_APP_KEY',
  'B2_BUCKET_DB_DUMPS_ID',
  'B2_BUCKET_DB_DUMPS_NAME',
  'B2_BUCKET_PORTFOLIO_ID',
  'B2_BUCKET_PORTFOLIO_NAME',
  'B2_BUCKET_AVATARS_ID',
  'B2_BUCKET_AVATARS_NAME',
  'B2_BUCKET_INVOICES_ID',
  'B2_BUCKET_INVOICES_NAME',
  'B2_BUCKET_CLIENT_REQUESTS_ID',
  'B2_BUCKET_CLIENT_REQUESTS_NAME',
  'PG_DUMP_BIN',
];

async function main() {
  const problems: string[] = [];
  const checks: Record<string, string> = {};

  // 1. APP_ENV.
  const appEnv = process.env.APP_ENV ?? '';
  if (appEnv !== 'production') {
    problems.push(`APP_ENV must be "production" (got "${appEnv}")`);
  }
  checks.appEnv = appEnv || '<missing>';

  // 2. Required env vars presence.
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    problems.push(`missing env vars: ${missing.join(', ')}`);
  }
  checks.requiredEnvPresent = `${REQUIRED_ENV.length - missing.length}/${REQUIRED_ENV.length}`;

  // 3. DATABASE_URL reachable (SELECT 1).
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.databaseReachable = 'ok';
  } catch (err) {
    problems.push(`DATABASE_URL unreachable: ${(err as Error).message.slice(0, 160)}`);
    checks.databaseReachable = 'fail';
  }

  // 4. pg_dump binary + version.
  const pgDumpBin = process.env.PG_DUMP_BIN ?? '';
  if (pgDumpBin) {
    try {
      const out = execFileSync(pgDumpBin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/pg_dump\s+\(PostgreSQL\)\s+(\d+)\.(\d+)/);
      if (!m) {
        problems.push(`pg_dump returned unexpected version string: "${out.trim()}"`);
      } else if (Number(m[1]) !== 16) {
        problems.push(`pg_dump major version is ${m[1]}, expected 16`);
      }
      checks.pgDumpVersion = out.trim();
    } catch (err) {
      problems.push(`pg_dump at PG_DUMP_BIN unusable: ${(err as Error).message.slice(0, 160)}`);
      checks.pgDumpVersion = 'fail';
    }
  }

  // 5. Prisma schema validates.
  try {
    execFileSync('npx', ['prisma', 'validate', '--config=./prisma.config.ts'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    checks.prismaSchemaValid = 'ok';
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().slice(0, 200) ?? '';
    problems.push(`prisma validate failed: ${stderr}`);
    checks.prismaSchemaValid = 'fail';
  }

  // 6. Make sure we're truly BOOTSTRAPPING — no VERIFIED production
  //    backup must already exist. If one does, the operator should
  //    switch to the routine `make prod-preflight`.
  try {
    const existing = await prisma.backupRun.findFirst({
      where: { status: BackupStatus.VERIFIED, environment: 'production' },
      select: { id: true, startedAt: true },
    });
    if (existing) {
      problems.push(
        `VERIFIED production backup already exists (id=${existing.id}, startedAt=${existing.startedAt.toISOString()}). Bootstrap preflight is for first-run only; use \`make prod-preflight\` for subsequent deploys.`,
      );
      checks.firstBootstrap = 'no';
    } else {
      checks.firstBootstrap = 'yes';
    }
  } catch {
    checks.firstBootstrap = 'unknown';
  } finally {
    await prisma.$disconnect();
  }

  console.log(JSON.stringify({ ok: problems.length === 0, checks, problems }, null, 2));
  if (problems.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[bootstrap-preflight] FAILED', (e as Error).message);
  process.exit(1);
});
