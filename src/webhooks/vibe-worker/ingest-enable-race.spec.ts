/**
 * MVCC-level concurrency spec for the ingestion ↔ enable race.
 *
 * Two Postgres connections (two PrismaClient instances), orchestrated
 * with timing so an enable-side transaction holds `FOR UPDATE` on
 * the Setting row while an ingestion-side transaction tries to
 * read the same row under `FOR SHARE` via
 * `SettingsService.getBooleanInsideTx`. We assert:
 *
 *   1. the ingestion read BLOCKS until the enable commit; it must
 *      NOT return the pre-commit value;
 *   2. after unblock, ingestion sees the flipped value and lands
 *      the JobPost with the correct `enqueueState` (PENDING when
 *      flag=true, BACKLOG when flag=false);
 *   3. multiple concurrent ingestions under FOR SHARE do NOT block
 *      each other.
 *
 * Transactions carry NO Redis / AI calls — DB only, as required.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { SettingsService } from '../../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SK } from '../../settings/settings-registry';

const prismaA = new PrismaClient();
const prismaB = new PrismaClient();
const settingsA = new SettingsService(prismaA as unknown as PrismaService);
const settingsB = new SettingsService(prismaB as unknown as PrismaService);
const createdJobPostIds: string[] = [];
const TAG = `race-${randomUUID().slice(0, 8)}`;

async function ensureSettingRow() {
  // Side-channel the setting row into existence using the service
  // (not under a transaction). After this, both connections can
  // observe the Setting + its SettingValue row.
  await settingsA.setSetting(SK.SCANNER_ANALYSIS_ENABLED, false);
}

beforeAll(async () => {
  await ensureSettingRow();
});

afterEach(async () => {
  if (createdJobPostIds.length) {
    await prismaA.jobPost
      .deleteMany({ where: { id: { in: createdJobPostIds } } })
      .catch(() => undefined);
    createdJobPostIds.length = 0;
  }
  // reset flag to a known baseline for the next test
  await settingsA.setSetting(SK.SCANNER_ANALYSIS_ENABLED, false).catch(() => undefined);
});

afterAll(async () => {
  await prismaA.$disconnect();
  await prismaB.$disconnect();
});

/**
 * Opens a transaction on `prismaA` that:
 *   - takes FOR UPDATE on the Setting row (via applyBooleanInsideTx);
 *   - flips SettingValue.value to `newValue`;
 *   - resolves `ready` once the lock is held;
 *   - holds the lock until `release` resolves, then commits.
 * The outer Promise resolves AFTER the commit lands.
 */
function openEnableWriter(newValue: boolean) {
  let ready!: () => void;
  const readyP = new Promise<void>((r) => {
    ready = r;
  });
  let release!: () => void;
  const releaseP = new Promise<void>((r) => {
    release = r;
  });
  const done = prismaA.$transaction(
    async (tx) => {
      await settingsA.applyBooleanInsideTx(
        tx,
        SK.SCANNER_ANALYSIS_ENABLED,
        newValue,
      );
      // Lock is now held; signal and wait for release.
      ready();
      await releaseP;
    },
    { timeout: 15_000 },
  );
  return { readyP, release, done };
}

describe('ingestion ↔ enable race — real MVCC', () => {
  it('ingestion reader BLOCKS on an in-flight enable writer and sees the committed value', async () => {
    // Baseline: flag=false (set in afterEach / beforeAll).
    const writer = openEnableWriter(true);
    await writer.readyP; // writer's FOR UPDATE is now held.

    // Ingestion-side read starts after the writer took the lock.
    const start = Date.now();
    let elapsedWhenRead = -1;
    const readerPromise = prismaB.$transaction(
      async (tx) => {
        const flag = await settingsB.getBooleanInsideTx(
          tx,
          SK.SCANNER_ANALYSIS_ENABLED,
          true,
        );
        elapsedWhenRead = Date.now() - start;
        return flag;
      },
      { timeout: 15_000 },
    );

    // Hold the writer's lock for ~250ms, then release.
    await new Promise((r) => setTimeout(r, 250));
    writer.release();
    await writer.done;

    const flagB = await readerPromise;
    // The reader must have blocked at least ~200ms waiting for
    // the writer's commit (fuzz factor for scheduler jitter).
    expect(elapsedWhenRead).toBeGreaterThanOrEqual(200);
    // ...and must observe the committed value (true), NOT the
    // pre-write baseline (false).
    expect(flagB).toBe(true);
  });

  it('post arriving after enable commit lands as PENDING, not BACKLOG', async () => {
    // Simulate the ingestion path end-to-end: enable commits
    // flag=true, then an ingestion txn reads+creates in one go.
    const writer = openEnableWriter(true);
    await writer.readyP;

    const readerPromise = prismaB.$transaction(async (tx) => {
      const flag = await settingsB.getBooleanInsideTx(
        tx,
        SK.SCANNER_ANALYSIS_ENABLED,
        true,
      );
      const providerJobId = `${TAG}_race_${Date.now()}_${Math.random()}`;
      const jp = await tx.jobPost.create({
        data: {
          providerJobId,
          rawText: 'x',
          rawPayload: {} as never,
          status: 'NEW',
          enqueueState: flag ? 'PENDING' : 'BACKLOG',
          scanner: 'vibe-worker',
          hSkillsKeywords: [],
        },
        select: { id: true, enqueueState: true },
      });
      return jp;
    });

    await new Promise((r) => setTimeout(r, 150));
    writer.release();
    await writer.done;

    const jp = await readerPromise;
    createdJobPostIds.push(jp.id);
    expect(jp.enqueueState).toBe('PENDING');
  });

  it('two FOR SHARE readers do NOT block each other', async () => {
    // Set the flag to false so both readers observe a stable value.
    await settingsA.setSetting(SK.SCANNER_ANALYSIS_ENABLED, false);

    const start = Date.now();
    const [a, b] = await Promise.all([
      prismaA.$transaction(async (tx) => {
        const flag = await settingsA.getBooleanInsideTx(
          tx,
          SK.SCANNER_ANALYSIS_ENABLED,
          true,
        );
        // Hold the FOR SHARE lock briefly; the other reader must
        // acquire concurrently.
        await new Promise((r) => setTimeout(r, 120));
        return flag;
      }),
      prismaB.$transaction(async (tx) => {
        const flag = await settingsB.getBooleanInsideTx(
          tx,
          SK.SCANNER_ANALYSIS_ENABLED,
          true,
        );
        await new Promise((r) => setTimeout(r, 120));
        return flag;
      }),
    ]);
    const elapsed = Date.now() - start;
    expect(a).toBe(false);
    expect(b).toBe(false);
    // If FOR SHARE blocked FOR SHARE, elapsed would be ~240ms.
    // Concurrent → ~120ms + overhead.
    expect(elapsed).toBeLessThan(220);
  });
});
