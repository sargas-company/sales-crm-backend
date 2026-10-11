/**
 * Live Postgres atomicity spec for `JobPostService.enableAnalysis`.
 *
 * Verifies the review-driven fix: flag flip + backlog strategy run
 * in ONE transaction, so a strategy failure rolls back the flag.
 * Cancel is a no-op. Concurrent enables serialise on the
 * SettingValue row (SELECT ... FOR UPDATE inside
 * `applyBooleanInsideTx`).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { randomUUID } from 'node:crypto';

import { JobPostService } from './job-post.service';
import { JobPostQueueService } from './job-post-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import {
  EnableAnalysisDto,
  EnableAnalysisStrategy,
} from './dto/enable-analysis.dto';
import {
  getTestPrisma,
  resetTestSettings,
  truncateScannerTables,
} from '../testing/test-clients';

const prisma = getTestPrisma();
const settingsService = new SettingsService(prisma as unknown as PrismaService);
const createdJobPostIds: string[] = [];
const TAG = `enable-${randomUUID().slice(0, 8)}`;

async function seedBacklog(count: number, ageHoursAgo = 0): Promise<string[]> {
  const createdAt = new Date(Date.now() - ageHoursAgo * 3600 * 1000);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await prisma.jobPost.create({
      data: {
        providerJobId: `${TAG}_${Date.now()}_${i}_${Math.random()}`,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'NEW',
        enqueueState: 'BACKLOG',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
        createdAt,
      },
      select: { id: true },
    });
    ids.push(row.id);
    createdJobPostIds.push(row.id);
  }
  return ids;
}

async function seedNew(
  enqueueState: 'BACKLOG' | 'PENDING' | 'ENQUEUED' | null,
  status: 'NEW' | 'PROCESSING' = 'NEW',
): Promise<string> {
  const row = await prisma.jobPost.create({
    data: {
      providerJobId: `${TAG}_${enqueueState ?? 'null'}_${status}_${Date.now()}_${Math.random()}`,
      rawText: 'x',
      rawPayload: {} as never,
      status,
      enqueueState,
      scanner: 'vibe-worker',
      hSkillsKeywords: [],
    } as never,
    select: { id: true },
  });
  createdJobPostIds.push(row.id);
  return row.id;
}

function makeQueue(): JobPostQueueService {
  return {
    enqueue: jest.fn(async () => undefined),
    forgetJob: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    reconcilePauseState: jest.fn(async () => undefined),
    queueCounts: jest.fn(async () => ({
      waiting: 0,
      delayed: 0,
      active: 0,
      paused: 0,
      prioritized: 0,
    })),
  } as unknown as JobPostQueueService;
}

function makeLiveEvents() {
  return {
    emitWebhookReceived: jest.fn(),
    emitJobPostChanged: jest.fn(),
    emitSettingsScanner: jest.fn(),
    emitDiscordDelivered: jest.fn(),
    stream$: jest.fn(),
  } as unknown as import('../live-events/live-events.service').LiveEventsService;
}

async function flipFlag(value: boolean) {
  await settingsService.setSetting(SK.SCANNER_ANALYSIS_ENABLED, value);
}

beforeAll(async () => {
  // Fresh test DB — nothing should be here, but normalise anyway so
  // a crashed previous run doesn't poison this suite.
  await truncateScannerTables(prisma);
  await resetTestSettings(prisma);
  await flipFlag(false);
});

beforeEach(async () => {
  // Full isolation: every test starts against an empty Scanner
  // table and a known analysisEnabled=false. Service calls like
  // `enableAnalysis` do `updateMany where status=NEW` without an
  // id filter, so we must not inherit state from the previous
  // test — not even "untracked" rows.
  await truncateScannerTables(prisma);
  await resetTestSettings(prisma);
  await flipFlag(false);
  createdJobPostIds.length = 0;
});

afterEach(async () => {
  await truncateScannerTables(prisma);
  await resetTestSettings(prisma);
  createdJobPostIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('enableAnalysis — flag atomicity', () => {
  it('cancel is a no-op: flag stays off, backlog untouched', async () => {
    const ids = await seedBacklog(3);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const dto: EnableAnalysisDto = { strategy: EnableAnalysisStrategy.CANCEL };

    const res = await svc.enableAnalysis(dto);
    expect(res.enqueued).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.analysisEnabled).toBe(false);

    const rows = await prisma.jobPost.findMany({
      where: { id: { in: ids } },
      select: { enqueueState: true, status: true },
    });
    for (const r of rows) {
      expect(r.status).toBe('NEW');
      expect(r.enqueueState).toBe('BACKLOG');
    }
    expect(
      await settingsService.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, true),
    ).toBe(false);
  });

  it('ALL strategy: flag flips to true, every snapshot BACKLOG → PENDING', async () => {
    const ids = await seedBacklog(4);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const dto: EnableAnalysisDto = { strategy: EnableAnalysisStrategy.ALL };

    const res = await svc.enableAnalysis(dto);
    // res.enqueued is a global count — other suites can leave
    // BACKLOG rows in the shared DB. We assert on OUR rows and
    // require the global count to be at least ours.
    expect(res.enqueued).toBeGreaterThanOrEqual(4);
    expect(res.analysisEnabled).toBe(true);

    const rows = await prisma.jobPost.findMany({
      where: { id: { in: ids } },
      select: { enqueueState: true, status: true },
    });
    for (const r of rows) {
      expect(r.enqueueState).toBe('PENDING');
    }
    expect(
      await settingsService.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, false),
    ).toBe(true);
  });

  it('NEW_POSTS_ONLY: every snapshot BACKLOG → SKIPPED; flag flips to true', async () => {
    const ids = await seedBacklog(2);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );

    const res = await svc.enableAnalysis({
      strategy: EnableAnalysisStrategy.NEW_POSTS_ONLY,
    });
    // Shared local DB can carry residual NEW rows from prior
    // suites. Assert on OUR seeded rows via the per-id read
    // below, and require the global count to be at least ours.
    expect(res.skipped).toBeGreaterThanOrEqual(2);
    expect(res.enqueued).toBe(0);

    const rows = await prisma.jobPost.findMany({
      where: { id: { in: ids } },
      select: { status: true, enqueueState: true },
    });
    for (const r of rows) {
      expect(r.status).toBe('SKIPPED');
      expect(r.enqueueState).toBeNull();
    }
  });

  it('RECENT{hours=1}: ≤1h BACKLOG → PENDING, older → SKIPPED', async () => {
    const recent = await seedBacklog(2, 0);
    const old = await seedBacklog(2, 48);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );

    const res = await svc.enableAnalysis({
      strategy: EnableAnalysisStrategy.RECENT,
      recent: { hours: 1 },
    });
    // Residual rows from other suites are counted globally; assert
    // on the per-id selectors below for the real check.
    expect(res.enqueued).toBeGreaterThanOrEqual(2);
    expect(res.skipped).toBeGreaterThanOrEqual(2);

    const recentRows = await prisma.jobPost.findMany({
      where: { id: { in: recent } },
      select: { status: true, enqueueState: true },
    });
    for (const r of recentRows) {
      expect(r.enqueueState).toBe('PENDING');
      expect(r.status).toBe('NEW');
    }
    const oldRows = await prisma.jobPost.findMany({
      where: { id: { in: old } },
      select: { status: true, enqueueState: true },
    });
    for (const r of oldRows) {
      expect(r.status).toBe('SKIPPED');
      expect(r.enqueueState).toBeNull();
    }
  });

  it('strategy throw rolls back the flag flip', async () => {
    await seedBacklog(1);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    // Force a throw by passing RECENT without the `recent` window.
    await expect(
      svc.enableAnalysis({ strategy: EnableAnalysisStrategy.RECENT } as EnableAnalysisDto),
    ).rejects.toThrow();
    expect(
      await settingsService.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, true),
    ).toBe(false);
  });
});

describe('bulkAnalyze — FAILED-only retry', () => {
  async function seed(providerId: string, data: Record<string, unknown>) {
    const row = await prisma.jobPost.create({
      data: {
        providerJobId: `${TAG}_${providerId}_${Date.now()}_${Math.random()}`,
        rawText: 'x',
        rawPayload: {} as never,
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
        ...data,
      } as never,
      select: { id: true },
    });
    createdJobPostIds.push(row.id);
    return row.id;
  }

  it('FAILED → NEW+PENDING with lastAnalysisError cleared; attempts history retained', async () => {
    const failed = await seed('f', {
      status: 'FAILED',
      lastAnalysisError: 'Anthropic 500',
      analysisAttempts: 3,
    });
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const res = await svc.bulkAnalyze([failed]);
    expect(res.requeued).toBe(1);

    const f = await prisma.jobPost.findUniqueOrThrow({ where: { id: failed } });
    expect(f.status).toBe('NEW');
    expect(f.enqueueState).toBe('PENDING');
    expect(f.lastAnalysisError).toBeNull();
    // Attempt history is diagnostic data — preserved across retry.
    expect(f.analysisAttempts).toBe(3);
  });

  it('mixed selection: only FAILED is re-queued; NEW / SKIPPED / PROCESSED / PROCESSING are untouched', async () => {
    const failed = await seed('f', {
      status: 'FAILED',
      lastAnalysisError: 'old error',
    });
    const newRow = await seed('n', {
      status: 'NEW',
      enqueueState: 'BACKLOG',
    });
    const skipped = await seed('s', {
      status: 'SKIPPED',
      processedAt: new Date(),
    });
    const processed = await seed('p', {
      status: 'PROCESSED',
      decision: 'approve',
      processedAt: new Date(),
    });
    const processing = await seed('pr', { status: 'PROCESSING' });

    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const res = await svc.bulkAnalyze([
      failed,
      newRow,
      skipped,
      processed,
      processing,
    ]);
    expect(res.requeued).toBe(1);

    const after = await prisma.jobPost.findMany({
      where: { id: { in: [failed, newRow, skipped, processed, processing] } },
      select: { id: true, status: true, enqueueState: true, decision: true },
    });
    const by = new Map(after.map((r) => [r.id, r]));
    expect(by.get(failed)?.status).toBe('NEW');
    expect(by.get(failed)?.enqueueState).toBe('PENDING');
    expect(by.get(newRow)?.status).toBe('NEW');
    expect(by.get(newRow)?.enqueueState).toBe('BACKLOG');
    expect(by.get(skipped)?.status).toBe('SKIPPED');
    expect(by.get(processed)?.status).toBe('PROCESSED');
    expect(by.get(processed)?.decision).toBe('approve');
    expect(by.get(processing)?.status).toBe('PROCESSING');
  });

  it('no FAILED in the selection → zero requeued, nothing changes', async () => {
    const newRow = await seed('n', {
      status: 'NEW',
      enqueueState: 'BACKLOG',
    });
    const processed = await seed('p', {
      status: 'PROCESSED',
      decision: 'approve',
      processedAt: new Date(),
    });
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const res = await svc.bulkAnalyze([newRow, processed]);
    expect(res.requeued).toBe(0);

    const [n, p] = await Promise.all([
      prisma.jobPost.findUniqueOrThrow({ where: { id: newRow } }),
      prisma.jobPost.findUniqueOrThrow({ where: { id: processed } }),
    ]);
    expect(n.status).toBe('NEW');
    expect(n.enqueueState).toBe('BACKLOG');
    expect(p.status).toBe('PROCESSED');
  });

  it('does NOT flip the kill-switch when AI is paused', async () => {
    const failed = await seed('f', {
      status: 'FAILED',
      lastAnalysisError: 'x',
    });
    await settingsService.setSetting(SK.SCANNER_ANALYSIS_ENABLED, false);

    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    await svc.bulkAnalyze([failed]);

    expect(
      await settingsService.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, true),
    ).toBe(false);
    const f = await prisma.jobPost.findUniqueOrThrow({ where: { id: failed } });
    // Row sits in PENDING waiting for scheduler + resume.
    expect(f.enqueueState).toBe('PENDING');
    expect(f.status).toBe('NEW');
  });

  it('second call on an already-requeued post is a no-op', async () => {
    const failed = await seed('f', { status: 'FAILED' });
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const first = await svc.bulkAnalyze([failed]);
    expect(first.requeued).toBe(1);
    const second = await svc.bulkAnalyze([failed]);
    expect(second.requeued).toBe(0);
    const f = await prisma.jobPost.findUniqueOrThrow({ where: { id: failed } });
    expect(f.status).toBe('NEW');
    expect(f.enqueueState).toBe('PENDING');
  });
});

describe('bulkSkip — concurrent-worker race', () => {
  it('does NOT overwrite PROCESSING; only NEW → SKIPPED', async () => {
    const newRow = await prisma.jobPost.create({
      data: {
        providerJobId: `${TAG}_new_${Date.now()}`,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'NEW',
        enqueueState: 'PENDING',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
      },
      select: { id: true },
    });
    const processingRow = await prisma.jobPost.create({
      data: {
        providerJobId: `${TAG}_proc_${Date.now()}`,
        rawText: 'x',
        rawPayload: {} as never,
        status: 'PROCESSING',
        scanner: 'vibe-worker',
        hSkillsKeywords: [],
      },
      select: { id: true },
    });
    createdJobPostIds.push(newRow.id, processingRow.id);

    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    const res = await svc.bulkSkip([newRow.id, processingRow.id]);
    expect(res.skipped).toBe(1);

    const [n, p] = await Promise.all([
      prisma.jobPost.findUniqueOrThrow({ where: { id: newRow.id } }),
      prisma.jobPost.findUniqueOrThrow({ where: { id: processingRow.id } }),
    ]);
    expect(n.status).toBe('SKIPPED');
    expect(n.enqueueState).toBeNull();
    expect(p.status).toBe('PROCESSING'); // worker still owns it
  });
});

describe('enableAnalysis — mixed-state Skip', () => {
  it('Skip while paused: BACKLOG + PENDING + ENQUEUED all → SKIPPED; PROCESSING untouched; new post after snapshot stays NEW', async () => {
    // Simulate a realistic pause: some posts arrived during the
    // pause (BACKLOG), some were PENDING from before the pause,
    // some had already been pushed to Redis (ENQUEUED), and one is
    // currently being analyzed (PROCESSING). Skip must drain
    // every accumulated NEW regardless of enqueueState and MUST
    // NOT touch the PROCESSING row.
    const backlog = await seedNew('BACKLOG');
    const nullState = await seedNew(null);
    const pending = await seedNew('PENDING');
    const enqueued = await seedNew('ENQUEUED');
    const processing = await seedNew('BACKLOG', 'PROCESSING');

    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );

    const res = await svc.enableAnalysis({
      strategy: EnableAnalysisStrategy.NEW_POSTS_ONLY,
    });
    expect(res.skipped).toBeGreaterThanOrEqual(4);
    expect(res.enqueued).toBe(0);

    // All four NEW rows (BACKLOG, NULL, PENDING, ENQUEUED) landed
    // in SKIPPED with enqueueState cleared.
    const rows = await prisma.jobPost.findMany({
      where: { id: { in: [backlog, nullState, pending, enqueued] } },
      select: { id: true, status: true, enqueueState: true },
    });
    for (const r of rows) {
      expect(r.status).toBe('SKIPPED');
      expect(r.enqueueState).toBeNull();
    }

    // PROCESSING is untouched — the worker still owns it.
    const proc = await prisma.jobPost.findUniqueOrThrow({
      where: { id: processing },
    });
    expect(proc.status).toBe('PROCESSING');

    // A post arriving AFTER the snapshot (new ingestion) is not in
    // the accumulated scope and must stay NEW.
    const afterSnapshot = await seedNew('BACKLOG');
    const after = await prisma.jobPost.findUniqueOrThrow({
      where: { id: afterSnapshot },
    });
    expect(after.status).toBe('NEW');
  });

  it('Process + Process repeated: second confirmation is a no-op even for PENDING/ENQUEUED rows', async () => {
    // Already-approved rows (PENDING / ENQUEUED) must not be
    // re-written by a second Process confirmation that arrives
    // after the first already committed. `alreadyEnabled` under the
    // Setting row lock guarantees this.
    const pending = await seedNew('PENDING');
    const enqueued = await seedNew('ENQUEUED');
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );
    // First Process flips AI on. Second must see alreadyEnabled → 0/0.
    await svc.enableAnalysis({ strategy: EnableAnalysisStrategy.ALL });
    const res2 = await svc.enableAnalysis({
      strategy: EnableAnalysisStrategy.NEW_POSTS_ONLY,
    });
    expect(res2.enqueued).toBe(0);
    expect(res2.skipped).toBe(0);
    const rows = await prisma.jobPost.findMany({
      where: { id: { in: [pending, enqueued] } },
      select: { enqueueState: true, status: true },
    });
    for (const r of rows) {
      expect(r.status).toBe('NEW');
      // Still PENDING — the second (Skip) call was a no-op; the
      // first (Process) demoted both PENDING and ENQUEUED into
      // PENDING idempotently.
      expect(r.enqueueState).toBe('PENDING');
    }
  });
});

describe('enableAnalysis — concurrent confirmations', () => {
  it('Process + Process concurrent: both complete; one approves the backlog, the other is a no-op', async () => {
    const ids = await seedBacklog(3);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );

    // Fire two Process confirmations in parallel. The row-level
    // FOR UPDATE lock on the Setting serialises them in the DB.
    const [res1, res2] = await Promise.all([
      svc.enableAnalysis({ strategy: EnableAnalysisStrategy.ALL }),
      svc.enableAnalysis({ strategy: EnableAnalysisStrategy.ALL }),
    ]);

    // Exactly one of the two should have moved OUR rows BACKLOG → PENDING;
    // the other sees `alreadyEnabled=true` and reports 0 enqueued. The
    // shared local DB may hold residual BACKLOG rows from other suites
    // so we assert on PER-ID state, and only check the sum of
    // reported `enqueued` is >= our 3 rows and non-negative on both.
    expect(res1.enqueued + res2.enqueued).toBeGreaterThanOrEqual(3);
    // Second call MUST report 0 enqueued — because by the time it
    // acquires the lock, AI is already on, and our scope is
    // {BACKLOG, NULL} which the first call drained. One of the two
    // returns must be exactly zero.
    expect([res1.enqueued, res2.enqueued]).toContain(0);

    const rows = await prisma.jobPost.findMany({
      where: { id: { in: ids } },
      select: { enqueueState: true, status: true },
    });
    // Every seeded row must have landed in PENDING — nobody got
    // left behind by the race.
    for (const r of rows) {
      expect(r.status).toBe('NEW');
      expect(r.enqueueState).toBe('PENDING');
    }
    expect(
      await settingsService.getBooleanForKey(SK.SCANNER_ANALYSIS_ENABLED, false),
    ).toBe(true);
  });

  it('Process + Skip concurrent: tasks approved by the first call are NEVER retroactively skipped', async () => {
    const ids = await seedBacklog(3);
    const svc = new JobPostService(
      prisma as unknown as PrismaService,
      settingsService,
      makeQueue(),
      makeLiveEvents(),
      { gateModel: () => 'claude-haiku-5-5', evalModel: () => 'claude-sonnet-5-5' } as never,
    );

    const [resAll, resSkip] = await Promise.all([
      svc.enableAnalysis({ strategy: EnableAnalysisStrategy.ALL }),
      svc.enableAnalysis({ strategy: EnableAnalysisStrategy.NEW_POSTS_ONLY }),
    ]);

    // Whichever call acquired the lock SECOND sees AI already on
    // and does nothing — its baseWhere is {BACKLOG, NULL}, scoped
    // to the pre-decision state. So if Process won first, Skip
    // reports 0 skipped. If Skip won first (3 rows → SKIPPED),
    // Process reports 0 enqueued because by then those rows have
    // status=SKIPPED and no longer match baseWhere.
    const bothCounts = [
      resAll.enqueued + resAll.skipped,
      resSkip.enqueued + resSkip.skipped,
    ];
    expect(bothCounts).toContain(0);
    expect(resAll.enqueued + resSkip.skipped).toBeGreaterThanOrEqual(3);

    // The seeded rows MUST be in a consistent state: either all
    // PENDING (Process won) OR all SKIPPED (Skip won). A row that
    // got approved by one call and then overwritten SKIPPED by the
    // other would be the race we are guarding against.
    const rows = await prisma.jobPost.findMany({
      where: { id: { in: ids } },
      select: { status: true, enqueueState: true },
    });
    const statuses = new Set(rows.map((r) => r.status));
    const states = new Set(rows.map((r) => r.enqueueState));
    expect(statuses.size).toBe(1);
    expect(states.size).toBe(1);
    const [status] = Array.from(statuses);
    const [state] = Array.from(states);
    const okPending = status === 'NEW' && state === 'PENDING';
    const okSkipped = status === 'SKIPPED' && state === null;
    expect(okPending || okSkipped).toBe(true);
  });
});
