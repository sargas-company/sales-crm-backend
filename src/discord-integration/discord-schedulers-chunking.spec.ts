/**
 * Chunked daily / weekly digest sender: delivery-row idempotency.
 *
 * Covers:
 *   - 23 daily reports → 3 bot.postMessage calls (10 + 10 + 3), each
 *     within Discord caps;
 *   - chunk 0 SENT + chunk 1 failed → next tick sends ONLY chunk 1
 *     (chunk 0 is not re-sent);
 *   - two concurrent tick entries into the same base period are
 *     serialised via the pg_try_advisory_lock gate (the second one
 *     exits without re-sending);
 *   - 429 Retry-After is logged but PENDING state is preserved;
 *   - a successful run flips every chunk row to SENT.
 *
 * Prisma / bot / embed-builder / late-reports are stubbed. The
 * scheduler is instantiated directly, and we call `sendChunked`
 * through the public `runDailyDigest` style indirection by reaching
 * into the private method with a type cast.
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
  status: DiscordDeliveryStatus;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
};

function makeDeliveryTable() {
  const store = new Map<string, DeliveryRow>();
  const api = {
    findUnique: jest.fn(async (args: { where: { deliveryKey: string } }) => {
      return store.get(args.where.deliveryKey) ?? null;
    }),
    create: jest.fn(async (args: { data: Partial<DeliveryRow> & { deliveryKey: string } }) => {
      const row: DeliveryRow = {
        id: `d-${store.size + 1}`,
        deliveryKey: args.data.deliveryKey,
        status: args.data.status as DiscordDeliveryStatus,
        attempts: args.data.attempts ?? 1,
        lastError: null,
        sentAt: null,
      };
      store.set(row.deliveryKey, row);
      return row;
    }),
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

function makePrismaStub(deliveryTable: ReturnType<typeof makeDeliveryTable>) {
  const profileUpdate = jest.fn(async () => undefined);
  return {
    discordDelivery: deliveryTable,
    discordProfile: { update: profileUpdate },
    // The chunked path uses pg_try_advisory_lock + pg_advisory_unlock
    // raw queries.
    $queryRaw: jest.fn(async () => [{ got: true }]),
  } as unknown as PrismaService;
}

function makeBot(impl: (args: unknown) => Promise<unknown>) {
  const postMessage = jest.fn(impl);
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

describe('DiscordSchedulersService.sendChunked — chunking + idempotency', () => {
  it('23 embeds → 3 bot.postMessage calls of 10 + 10 + 3; all delivery rows SENT', async () => {
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries);
    const bot = makeBot(async () => ({ ok: true, messageId: 'm' }));
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
    const sizes = bot.postMessage.mock.calls.map(
      (c) => ((c[0] as { embeds: unknown[] }).embeds ?? []).length,
    );
    expect(sizes).toEqual([10, 10, 3]);
    // Content only on the first chunk.
    expect(
      (bot.postMessage.mock.calls[0][0] as { content?: string }).content,
    ).toBe('Daily reports — 2026-02-10');
    expect(
      (bot.postMessage.mock.calls[1][0] as { content?: string }).content,
    ).toBeUndefined();
    // Every chunk row SENT at the end.
    const keys = [
      'DAILY_DIGEST_19:2026-02-10:chunk:0',
      'DAILY_DIGEST_19:2026-02-10:chunk:1',
      'DAILY_DIGEST_19:2026-02-10:chunk:2',
    ];
    for (const k of keys) {
      expect(deliveries._store.get(k)?.status).toBe(DiscordDeliveryStatus.SENT);
    }
    // Mentions are hard-disabled for every chunk.
    for (const call of bot.postMessage.mock.calls) {
      expect((call[0] as { allowedMentions: unknown }).allowedMentions).toEqual({
        parse: [],
      });
    }
  });

  it('chunk 0 SENT, chunk 1 fails → next tick sends ONLY chunks 1 and 2, no double-send', async () => {
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries);

    let callIdx = 0;
    const bot = makeBot(async () => {
      callIdx += 1;
      if (callIdx === 2) {
        return { ok: false, status: 500, message: 'upstream flake' };
      }
      return { ok: true, messageId: `m-${callIdx}` };
    });
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const first = () =>
      invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(23),
      });
    await first();
    // Chunk 0 SENT, chunk 1 PENDING, chunk 2 never created.
    expect(
      deliveries._store.get('DAILY_DIGEST_19:2026-02-10:chunk:0')?.status,
    ).toBe(DiscordDeliveryStatus.SENT);
    expect(
      deliveries._store.get('DAILY_DIGEST_19:2026-02-10:chunk:1')?.status,
    ).toBe(DiscordDeliveryStatus.PENDING);
    expect(deliveries._store.has('DAILY_DIGEST_19:2026-02-10:chunk:2')).toBe(
      false,
    );

    bot.postMessage.mockClear();
    // Next tick: bot now succeeds for every call.
    (bot.postMessage as jest.Mock).mockImplementation(async () => ({
      ok: true,
      messageId: 'ok',
    }));
    await first();
    // Second run must call postMessage TWICE — chunk 1 and chunk 2.
    expect(bot.postMessage).toHaveBeenCalledTimes(2);
    const sizes = bot.postMessage.mock.calls.map(
      (c) => ((c[0] as { embeds: unknown[] }).embeds ?? []).length,
    );
    expect(sizes).toEqual([10, 3]);
    // All three chunks are now SENT.
    for (const i of [0, 1, 2]) {
      expect(
        deliveries._store.get(`DAILY_DIGEST_19:2026-02-10:chunk:${i}`)?.status,
      ).toBe(DiscordDeliveryStatus.SENT);
    }
  });

  it('two parallel ticks on the same base period → only ONE actually sends (advisory lock)', async () => {
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries);
    let locked = false;
    prisma.$queryRaw = (async (strings: TemplateStringsArray) => {
      const sql = strings.join('').trim();
      if (sql.startsWith('SELECT pg_try_advisory_lock')) {
        if (locked) return [{ got: false }];
        locked = true;
        return [{ got: true }];
      }
      if (sql.startsWith('SELECT pg_advisory_unlock')) {
        locked = false;
        return [{ got: true }];
      }
      return [];
    }) as unknown as PrismaService['$queryRaw'];
    const bot = makeBot(async () => ({ ok: true, messageId: 'm' }));
    const svc = new DiscordSchedulersService(
      prisma,
      bot,
      stubEmbeds,
      stubLate,
      stubConfig,
    );
    const [, ] = await Promise.all([
      invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(23),
      }),
      invokeSendChunked(svc, {
        profile: PROFILE,
        jobType: DiscordJobType.DAILY_DIGEST_19,
        periodKey: '2026-02-10',
        channelId: PROFILE.pmsChannelId!,
        content: 'Daily',
        embeds: makeEmbeds(23),
      }),
    ]);
    expect(bot.postMessage).toHaveBeenCalledTimes(3);
  });

  it('429 Retry-After → chunk stays PENDING for the next tick', async () => {
    const deliveries = makeDeliveryTable();
    const prisma = makePrismaStub(deliveries);
    const bot = makeBot(async () => ({
      ok: false,
      status: 429,
      message: 'rate limited',
      retryAfterMs: 5000,
    }));
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
    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    expect(
      deliveries._store.get('DAILY_DIGEST_19:2026-02-10:chunk:0')?.status,
    ).toBe(DiscordDeliveryStatus.PENDING);
  });
});
