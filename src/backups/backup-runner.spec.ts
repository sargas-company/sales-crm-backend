import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'node:fs';
import {
  BackupStatus,
  BackupType,
  type BackupRun,
  type PrismaClient,
} from '@prisma/client';

import { runBackup } from './backup-runner';

/**
 * Backup runner unit tests. All external effects (pg_dump, pg_restore,
 * psql, B2, advisory lock) are injected as test doubles so the real
 * runner can be exercised end-to-end without a database or network.
 */

interface Captured {
  runs: BackupRun[];
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  pgDumpCalls: number;
  pgRestoreListCalls: number;
  uploads: string[];
  downloads: string[];
  locks: Array<'acquire' | 'release'>;
}

function makePrismaDouble(cap: Captured): PrismaClient {
  const prisma = {
    backupRun: {
      create: async ({ data }: { data: Partial<BackupRun> }) => {
        const row: BackupRun = {
          id: `run-${cap.runs.length + 1}`,
          type: data.type as BackupType,
          status: BackupStatus.RUNNING,
          environment: (data.environment as string) ?? 'local',
          databaseName: (data.databaseName as string) ?? 'ai_dashboard',
          startedAt: (data.startedAt as Date) ?? new Date(),
          completedAt: null,
          durationMs: null,
          artifactKey: null,
          manifestKey: null,
          size: null,
          checksum: null,
          checksumAlgo: 'sha256',
          pgVersion: null,
          gitSha: data.gitSha ?? null,
          migrationName: null,
          triggeredBy: data.triggeredBy ?? null,
          errorMessage: null,
          lastVerifiedAt: null,
        };
        cap.runs.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        cap.updates.push({ id: where.id, data });
        const idx = cap.runs.findIndex((r) => r.id === where.id);
        if (idx >= 0) {
          cap.runs[idx] = { ...cap.runs[idx], ...(data as Partial<BackupRun>) } as BackupRun;
          return cap.runs[idx];
        }
        return cap.runs[0];
      },
    },
  } as unknown as PrismaClient;
  return prisma;
}

function makeDepsHappy(cap: Captured, overrides: Partial<{
  dumpContent: Buffer;
  pgDumpThrows: boolean;
  pgRestoreThrows: boolean;
  pgRestoreThrowsOn: 'local' | 'roundtrip';
  mutateDownloadedBytes: boolean;
  lockDenied: boolean;
}> = {}) {
  const content = overrides.dumpContent ?? Buffer.from('fake-dump-bytes');
  const uploadedByKey = new Map<string, Buffer>();
  let listCallIndex = 0;
  return {
    pgDump: async (args: { outPath: string }) => {
      cap.pgDumpCalls++;
      if (overrides.pgDumpThrows) throw new Error('pg_dump exited 1: boom');
      await fs.promises.writeFile(args.outPath, content);
    },
    pgRestoreList: async () => {
      listCallIndex++;
      cap.pgRestoreListCalls++;
      if (overrides.pgRestoreThrows) {
        const target = overrides.pgRestoreThrowsOn ?? 'local';
        const shouldThrow =
          (target === 'local' && listCallIndex === 1) ||
          (target === 'roundtrip' && listCallIndex === 2);
        if (shouldThrow) {
          throw new Error('pg_restore --list exited 1: corrupt archive');
        }
      }
    },
    pgServerVersion: async () => '16.0',
    pgDumpClientVersion: async () => 'pg_dump (PostgreSQL) 16.0',
    lastMigrationName: async () => 'init',
    tryAcquireLock: async () => {
      if (overrides.lockDenied) {
        cap.locks.push('acquire');
        return false;
      }
      cap.locks.push('acquire');
      return true;
    },
    releaseLock: async () => {
      cap.locks.push('release');
    },
    b2Factory: () =>
      ({
        authorize: async () => undefined,
        getUploadUrl: async () => ({
          data: { uploadUrl: 'u://x', authorizationToken: 't' },
        }),
        uploadFile: async (args: {
          fileName: string;
          data: Buffer;
          contentLength: number;
        }) => {
          cap.uploads.push(args.fileName);
          uploadedByKey.set(args.fileName, Buffer.from(args.data));
          return { data: { fileId: 'fid-' + args.fileName } };
        },
        downloadFileByName: async (args: { fileName: string }) => {
          cap.downloads.push(args.fileName);
          const original = uploadedByKey.get(args.fileName) ?? Buffer.alloc(0);
          const bytes = overrides.mutateDownloadedBytes
            ? Buffer.concat([original, Buffer.from('tamper')])
            : original;
          return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        },
      } as unknown as import('backblaze-b2')),
  };
}

const BASE_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://u:p@localhost:5433/ai_dashboard',
  B2_BUCKET_DB_DUMPS_ID: 'bucket-id',
  B2_BUCKET_DB_DUMPS_NAME: 'bucket-name',
  B2_KEY_ID: 'kid',
  B2_APP_KEY: 'app',
};

describe('runBackup — happy path', () => {
  let cap: Captured;
  beforeEach(() => {
    cap = { runs: [], updates: [], pgDumpCalls: 0, pgRestoreListCalls: 0, uploads: [], downloads: [], locks: [] };
  });

  it('runs the full flow and marks the row VERIFIED', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    const result = await runBackup(
      {
        type: BackupType.MANUAL,
        triggeredBy: 'test',
        env: BASE_ENV,
        logger: sink,
        prisma: makePrismaDouble(cap),
      },
      makeDepsHappy(cap),
    );
    expect(result.run.status).toBe(BackupStatus.VERIFIED);
    expect(result.run.lastVerifiedAt).toBeTruthy();
    expect(cap.pgDumpCalls).toBe(1);
    expect(cap.pgRestoreListCalls).toBe(2); // local + round-trip
    expect(cap.uploads.length).toBe(2); // artifact + manifest
    expect(cap.downloads.length).toBe(1);
    expect(cap.locks).toEqual(['acquire', 'release']);
    const final = cap.updates.at(-1);
    expect(final?.data.status).toBe(BackupStatus.VERIFIED);
  });
});

describe('runBackup — failure branches', () => {
  let cap: Captured;
  beforeEach(() => {
    cap = { runs: [], updates: [], pgDumpCalls: 0, pgRestoreListCalls: 0, uploads: [], downloads: [], locks: [] };
  });

  it('refuses when the advisory lock is already held', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    await expect(
      runBackup(
        {
          type: BackupType.MANUAL,
          env: BASE_ENV,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap, { lockDenied: true }),
      ),
    ).rejects.toThrow(/Another backup is already running/);
    // Row must not be created when the lock refuses.
    expect(cap.runs.length).toBe(0);
    expect(cap.pgDumpCalls).toBe(0);
  });

  it('marks the row FAILED when pre-upload pg_restore --list fails', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    await expect(
      runBackup(
        {
          type: BackupType.DAILY,
          env: BASE_ENV,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap, {
          pgRestoreThrows: true,
          pgRestoreThrowsOn: 'local',
        }),
      ),
    ).rejects.toThrow(/pg_restore --list exited/);
    const final = cap.updates.at(-1);
    expect(final?.data.status).toBe(BackupStatus.FAILED);
    expect(cap.uploads).toEqual([]); // no upload reached
    expect(cap.locks).toEqual(['acquire', 'release']);
  });

  it('marks FAILED when the round-trip pg_restore --list fails', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    await expect(
      runBackup(
        {
          type: BackupType.MANUAL,
          env: BASE_ENV,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap, {
          pgRestoreThrows: true,
          pgRestoreThrowsOn: 'roundtrip',
        }),
      ),
    ).rejects.toThrow();
    const final = cap.updates.at(-1);
    expect(final?.data.status).toBe(BackupStatus.FAILED);
    // Artifact + manifest uploaded, but VERIFIED must NOT be set.
    expect(cap.uploads.length).toBe(2);
    expect(cap.downloads.length).toBe(1);
  });

  it('marks FAILED when the downloaded artifact checksum does not match', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    await expect(
      runBackup(
        {
          type: BackupType.MANUAL,
          env: BASE_ENV,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap, { mutateDownloadedBytes: true }),
      ),
    ).rejects.toThrow(/Checksum mismatch/);
    const final = cap.updates.at(-1);
    expect(final?.data.status).toBe(BackupStatus.FAILED);
  });

  it('refuses the whole flow when backup credentials are missing in production', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    const env: NodeJS.ProcessEnv = {
      ...BASE_ENV,
      APP_ENV: 'production',
      B2_KEY_ID: '',
      B2_APP_KEY: '',
    };
    await expect(
      runBackup(
        {
          type: BackupType.MANUAL,
          env,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap),
      ),
    ).rejects.toThrow(/B2_BACKUP_KEY_ID/);
    expect(cap.pgDumpCalls).toBe(0);
    expect(cap.runs.length).toBe(0);
  });

  it('cleans up the scratch dir even on failure', async () => {
    const sink = { log: () => undefined, error: () => undefined };
    // Capture tmp dir names created during the run.
    const origMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const created: string[] = [];
    fs.promises.mkdtemp = (async (prefix: string) => {
      const dir = await origMkdtemp(prefix);
      created.push(dir);
      return dir;
    }) as typeof fs.promises.mkdtemp;
    try {
      await runBackup(
        {
          type: BackupType.MANUAL,
          env: BASE_ENV,
          logger: sink,
          prisma: makePrismaDouble(cap),
        },
        makeDepsHappy(cap, { pgDumpThrows: true }),
      ).catch(() => undefined);
    } finally {
      fs.promises.mkdtemp = origMkdtemp;
    }
    expect(created.length).toBe(1);
    expect(fs.existsSync(created[0])).toBe(false);
    expect(cap.locks).toEqual(['acquire', 'release']);
  });
});
