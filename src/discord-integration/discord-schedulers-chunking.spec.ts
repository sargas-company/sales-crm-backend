/**
 * Chunked digest sender — claim/send/finalize contract.
 *
 * The sender MUST NOT keep a Prisma transaction open across the
 * Discord HTTP call. Instead each chunk goes through three short
 * transactions:
 *
 *   1. claim — acquires `pg_try_advisory_xact_lock(hash31(key))`,
 *      upserts the `DiscordDelivery` row, writes an in-flight
 *      lease (`sentAt = now + CHUNK_LEASE_TTL_MS`), commits.
 *   2. send — bot.postMessage runs with NO open DB transaction.
 *   3. finalize — short UPDATE: SENT, PENDING+lease(429),
 *      PENDING+null (recoverable fail), or lastError-only
 *      (ambiguous / thrown).
 *
 * Idempotency is anchored on the row's state, not on the
 * transaction scope — so a chunk-1 exception can never rollback
 * chunk 0's SENT row.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
  type DiscordProfile,
} from '@prisma/client';

import type { ConfigService } from '@nestjs/config';
import type { DiscordEmbed } from './discord-chunking';
import type { DiscordBotClient } from './discord-bot.client';
import type { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import type { DiscordLateReportService } from './discord-late-report.service';
import { DiscordSchedulersService } from './discord-schedulers.service';
import type { PrismaService } from '../prisma/prisma.service';

type DeliveryRow = {
  id: string;
  deliveryKey: string;
  profileId: string;
  jobType: DiscordJobType;
  periodKey: string;
  status: DiscordDeliveryStatus;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
};

type OpenTxGuard = { depth: number; maxConcurrent: number };

function makeDeliveryTable() {
  const store = new Map<string, DeliveryRow>();
  let autoId = 1;
  const api = {
    findUnique: jest.fn(async (args: { where: { deliveryKey: string } }) => {
      return store.get(args.where.deliveryKey) ?? null;
    }),
    create: jest.fn(
      async (args: { data: Partial<DeliveryRow> & { deliveryKey: string } }) => {
        const row: DeliveryRow = {
          id: `d-${autoId++}`,
          deliveryKey: args.data.deliveryKey,
          profileId: args.data.profileId as string,
          jobType: args.data.jobType as DiscordJobType,
          periodKey: args.data.periodKey as string,
          status: (args.data.status as DiscordDeliveryStatus) ?? DiscordDeliveryStatus.PENDING,
          attempts: args.data.attempts ?? 1,
          lastError: null,
          sentAt: args.data.sentAt ?? null,
        };
        store.set(row.deliveryKey, row);
        return row;
      },
    ),
    update: jest.fn(
      async (args: {
        where: { id?: string; deliveryKey?: string };
        data: Partial<DeliveryRow>;
      }) => {
        const row = args.where.deliveryKey
          ? store.get(args.where.deliveryKey)!
          : [...store.values()].find((r) => r.id === args.where.id)!;
        Object.assign(row, args.data);
        return row;
      },
    ),
    _store: store,
  };
  return api;
}

/**
 * Prisma stub that tracks whether a `$transaction` is currently
 * open while bot HTTP calls fire — the test asserts this never
 * happens. The stub routes `$transaction(cb)` into `cb(txClient)`
 * synchronously, bumping an "open depth" counter on entry and
 * decrementing on exit.
 */
function makePrismaStub(
  deliveryTable: ReturnType<typeof makeDeliveryTable>,
  opts: {
    lockAvailable?: boolean | ((key: number) => boolean);
    openTxGuard: OpenTxGuard;
  },
) {
  const profileUpdate = jest.fn(async () => undefined);
  const lockDecider =
    typeof opts.lockAvailable === 'function'
      ? opts.lockAvailable
      : () => opts.lockAvailable ?? true;
  const tx = {
    discordDelivery: deliveryTable,
    discordProfile: { update: profileUpdate },
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const sql = strings.join('').trim();
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const key = Number(vals[0] ?? 0);
        return Promise.resolve([{ got: lockDecider(key) }]);
      }
      return Promise.resolve([]);
    }),
  };
  return {
    ...tx,
    $transaction: jest.fn(async (cb: (c: typeof tx) => Promise<unknown>) => {
      opts.openTxGuard.depth += 1;
      opts.openTxGuard.maxConcurrent = Math.max(
        opts.openTxGuard.maxConcurrent,
        opts.openTxGuard.depth,
      );
      try {
        return await cb(tx);
      } finally {
        opts.openTxGuard.depth -= 1;
      }
    }),
    _tx: tx,
  } as unknown as PrismaService;
}

function makeBot(
  impl: (args: unknown, guard: OpenTxGuard) => Promise<unknown>,
  guard: OpenTxGuard,
) {
  const postMessage = jest.fn(async (args: unknown) => impl(args, guard));
  return { postMessage } as unknown as DiscordBotClient & {
    postMessage: jest.Mock;
  };
}

const stubEmbeds = {} as DiscordEmbedBuilderService;
const stubLate = {} as DiscordLateReportService;
const stubConfig = { get: () => '' } as unknown as ConfigService;

const PROFILE: DiscordProfile = {
  id: 'prof-1',
  name: 'TEST',
  active: true,
  pmsChannelId: 'ch-pms',
  opsChannelId: null,
  salesChannelId: null,
  generalChannelId: null,
  managerRoleId: null,
  guildId: null,
  reportsEnabled: true,
  birthdaysEnabled: true,
  absencesEnabled: true,
  weeklyEnabled: true,
  cutoffHour: 10,
  reminderAt: '18:00',
  dailyDigestAt: '19:00',
  weeklyDigestDay: 1,
  weeklyDigestAt: '09:00',
  birthdayAt: '09:00',
  absencesAt: '09:00',
  timezone: 'Europe/Kyiv',
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureMessage: null,
} as unknown as DiscordProfile;

function makeEmbeds(count: number): DiscordEmbed[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Project ${i}`,
    description: `${i + 1} hours`,
  }));
}

function invokeSendChunked(
  svc: DiscordSchedulersService,
  args: {
    profile: DiscordProfile;
    jobType: DiscordJobType;
    periodKey: string;
    channelId: string;
    content: string;
    embeds: readonly DiscordEmbed[];
  },
): Promise<void> {
  return (
    svc as unknown as {
      sendChunked: (a: typeof args) => Promise<void>;
    }
  ).sendChunked(args);
}

const DAILY_KEY = (i: number) => `DAILY_DIGEST_19:2026-02-10:chunk:${i}`;

describe('DiscordSchedulersService.sendChunked — claim/send/finalize', () => {
  it('23 embeds → 3 bot calls (10 + 10 + 3); no $transaction is open during any bot.postMessage', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    const observedTxDepthAtSend: number[] = [];
    const bot = makeBot(async (_args, g) => {
      observedTxDepthAtSend.push(g.depth);
      return { ok: true, messageId: 'm' };
    }, guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    await invokeSendChunked(svc, {
      profile: PROFILE,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey: '2026-02-10',
      channelId: PROFILE.pmsChannelId!,
      content: 'Daily reports — 2026-02-10',
      embeds: makeEmbeds(23),
    });
    expect(bot.postMessage).toHaveBeenCalledTimes(3);
    expect(
      bot.postMessage.mock.calls.map(
        (c) => ((c[0] as { embeds: unknown[] }).embeds ?? []).length,
      ),
    ).toEqual([10, 10, 3]);
    // Every bot call fired with zero open transactions.
    expect(observedTxDepthAtSend).toEqual([0, 0, 0]);
    expect(guard.maxConcurrent).toBeGreaterThan(0);
    expect(guard.depth).toBe(0);
    for (const i of [0, 1, 2]) {
      expect(deliveries._store.get(DAILY_KEY(i))?.status).toBe(
        DiscordDeliveryStatus.SENT,
      );
    }
  });

  it('chunk 0 SENT then chunk 1 throws → chunk 0 stays SENT; next tick retries ONLY chunk 1 (and 2)', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });

    let callIdx = 0;
    const bot = makeBot(async () => {
      callIdx += 1;
      if (callIdx === 2) throw new Error('socket hang up');
      return { ok: true, messageId: `m-${callIdx}` };
    }, guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const run = () =>
      invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(23),
      });

    const T0 = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    try {
      await run();
      // chunk 0 SENT (and stays that way), chunk 1 PENDING with
      // in-flight lease (sentAt > T0), chunk 2 not touched yet.
      expect(deliveries._store.get(DAILY_KEY(0))?.status).toBe(
        DiscordDeliveryStatus.SENT,
      );
      const chunk1Row = deliveries._store.get(DAILY_KEY(1));
      expect(chunk1Row?.status).toBe(DiscordDeliveryStatus.PENDING);
      expect(chunk1Row?.lastError).toContain('socket hang up');
      expect(deliveries._store.has(DAILY_KEY(2))).toBe(false);

      // Early tick (30 s later) is still inside the lease.
      nowSpy.mockReturnValue(T0 + 30_000);
      bot.postMessage.mockClear();
      (bot.postMessage as jest.Mock).mockImplementation(async () => ({
        ok: true,
        messageId: 'should-not-fire',
      }));
      await run();
      expect(bot.postMessage).not.toHaveBeenCalled();

      // Late tick (3 min later): lease expired, chunk 1 retries;
      // chunk 0 is already SENT and is skipped — no double send.
      nowSpy.mockReturnValue(T0 + 180_000);
      bot.postMessage.mockClear();
      await run();
      expect(bot.postMessage).toHaveBeenCalledTimes(2);
      expect(
        bot.postMessage.mock.calls.map(
          (c) => ((c[0] as { embeds: unknown[] }).embeds ?? []).length,
        ),
      ).toEqual([10, 3]);
      for (const i of [0, 1, 2]) {
        expect(deliveries._store.get(DAILY_KEY(i))?.status).toBe(
          DiscordDeliveryStatus.SENT,
        );
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('contended claim (another instance holds the xact lock) → bot is NOT called, exits cleanly', async () => {
    // Simulates: another Nest instance is inside its claim
    // transaction holding `pg_try_advisory_xact_lock(hash31(chunk 0))`.
    // Our run tries to claim, pg returns `got=false`, we exit.
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, {
      openTxGuard: guard,
      lockAvailable: false,
    });
    const bot = makeBot(async () => ({ ok: true, messageId: 'never' }), guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    await invokeSendChunked(svc, {
      profile: PROFILE,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey: '2026-02-10',
      channelId: PROFILE.pmsChannelId!,
      content: 'Daily',
      embeds: makeEmbeds(3),
    });
    expect(bot.postMessage).not.toHaveBeenCalled();
    // No delivery row persisted either — the losing instance did
    // not create a stale PENDING.
    expect(deliveries._store.size).toBe(0);
  });

  it('after a crash-mid-send, the surviving row with an expired lease is re-claimed and retried', async () => {
    // Simulates the "backend crashed between a successful bot POST
    // and the finalise commit" case: the row stays PENDING with a
    // past lease. A later tick claims it and resends — this is the
    // at-least-once guarantee we document.
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const T0 = 1_900_000_000_000;
    deliveries._store.set(DAILY_KEY(0), {
      id: 'crashed-0',
      deliveryKey: DAILY_KEY(0),
      profileId: PROFILE.id,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey: '2026-02-10',
      status: DiscordDeliveryStatus.PENDING,
      attempts: 1,
      lastError: null,
      // Lease expired 10 minutes ago.
      sentAt: new Date(T0 - 10 * 60 * 1000),
    });
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    const bot = makeBot(async () => ({ ok: true, messageId: 'retry' }), guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    try {
      await invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(1),
      });
      expect(bot.postMessage).toHaveBeenCalledTimes(1);
      expect(deliveries._store.get(DAILY_KEY(0))?.status).toBe(
        DiscordDeliveryStatus.SENT,
      );
      expect(deliveries._store.get(DAILY_KEY(0))?.attempts).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('active lease on an existing PENDING row → bot is NOT called', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    // Pre-seed chunk 0 as PENDING with a lease 60 s in the future.
    const T0 = 1_800_000_000_000;
    deliveries._store.set(DAILY_KEY(0), {
      id: 'pre-0',
      deliveryKey: DAILY_KEY(0),
      profileId: PROFILE.id,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey: '2026-02-10',
      status: DiscordDeliveryStatus.PENDING,
      attempts: 1,
      lastError: null,
      sentAt: new Date(T0 + 60_000),
    });
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    const bot = makeBot(async () => ({ ok: true, messageId: 'never' }), guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    try {
      await invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(5),
      });
      expect(bot.postMessage).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('429 Retry-After → PENDING with lease; early tick skips, late tick retries', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    const bot = makeBot(async () => ({
      ok: false,
      status: 429,
      message: 'rate limited',
      retryAfterMs: 120_000,
    }), guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const run = () =>
      invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(5),
      });

    const T0 = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0);
    try {
      await run();
      expect(bot.postMessage).toHaveBeenCalledTimes(1);
      const row = deliveries._store.get(DAILY_KEY(0));
      expect(row?.status).toBe(DiscordDeliveryStatus.PENDING);
      expect(row?.sentAt?.getTime()).toBe(T0 + 120_000);

      // Early tick within window → bot not called, lease unchanged.
      nowSpy.mockReturnValue(T0 + 60_000);
      bot.postMessage.mockClear();
      (bot.postMessage as jest.Mock).mockImplementation(async () => ({
        ok: true,
        messageId: 'should-not-fire',
      }));
      await run();
      expect(bot.postMessage).not.toHaveBeenCalled();
      expect(
        deliveries._store.get(DAILY_KEY(0))?.sentAt?.getTime(),
      ).toBe(T0 + 120_000);

      // Late tick past window → retries chunk 0 successfully.
      nowSpy.mockReturnValue(T0 + 180_000);
      bot.postMessage.mockClear();
      await run();
      expect(bot.postMessage).toHaveBeenCalledTimes(1);
      expect(deliveries._store.get(DAILY_KEY(0))?.status).toBe(
        DiscordDeliveryStatus.SENT,
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('every $transaction callback is short and does NOT contain the bot.postMessage call', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    let depthMax = 0;
    const bot = makeBot(async (_args, g) => {
      depthMax = Math.max(depthMax, g.depth);
      return { ok: true, messageId: 'm' };
    }, guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    await invokeSendChunked(svc, {
      profile: PROFILE,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey: '2026-02-10',
      channelId: PROFILE.pmsChannelId!,
      content: 'Daily',
      embeds: makeEmbeds(5),
    });
    expect(depthMax).toBe(0);
  });
});

describe('DiscordSchedulersService.sendChunked — absences content-only path', () => {
  it('empty embed list + content → single ABSENCES:<date>:chunk:0 delivery with content-only message', async () => {
    const guard: OpenTxGuard = { depth: 0, maxConcurrent: 0 };
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries, { openTxGuard: guard });
    const bot = makeBot(async () => ({ ok: true, messageId: 'm' }), guard);
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    await invokeSendChunked(svc, {
      profile: PROFILE,
      jobType: DiscordJobType.ABSENCES,
      periodKey: '2026-02-10',
      channelId: PROFILE.pmsChannelId!,
      content: 'Everyone is working today.',
      embeds: [],
    });
    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    const call = bot.postMessage.mock.calls[0][0] as {
      content?: string;
      embeds?: unknown;
    };
    expect(call.content).toBe('Everyone is working today.');
    expect(call.embeds).toBeUndefined();
    expect(
      deliveries._store.get('ABSENCES:2026-02-10:chunk:0')?.status,
    ).toBe(DiscordDeliveryStatus.SENT);
  });
});
