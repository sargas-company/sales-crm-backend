/**
 * DiscordLateReportService.tick — ensures that the PMS payload is
 * the dedicated `lateReportCard` shape:
 *   • title `⏰ Late report — {projectName}`;
 *   • exactly two inline fields: 🕒 Hours + 📅 For day;
 *   • no description, no Submitted at, no Details, no body text;
 *   • palette is LEGACY_BLUE / LEGACY_RED (shared `hours > 6`
 *     comparator — the SAME threshold the daily digest uses);
 *   • snapshot carrying extra text / submittedAt fields is
 *     tolerated — the builder reads only projectName + hours +
 *     reportDate;
 *   • already-SENT rows are not re-sent;
 *   • a successful send flips the row to SENT with `attempts += 1`.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
} from '@prisma/client';

import {
  DiscordEmbedBuilderService,
  LEGACY_BLUE,
  LEGACY_RED,
} from './discord-embed-builder.service';
import { DiscordLateReportService } from './discord-late-report.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscordBotClient } from './discord-bot.client';

const PROFILE_ID = 'profile-1';

const makeStubs = (
  pendingRows: Array<{
    id: string;
    status: DiscordDeliveryStatus;
    attempts: number;
    periodKey: string;
  }>,
  botOk = true,
) => {
  const update = jest.fn(async () => undefined);
  const findMany = jest.fn(async () =>
    pendingRows.filter((r) => r.status === DiscordDeliveryStatus.PENDING),
  );
  const findFirstProfile = jest.fn(async () => ({
    id: PROFILE_ID,
    pmsChannelId: 'pms-channel',
    reportsEnabled: true,
  }));

  const prisma = {
    discordProfile: { findFirst: findFirstProfile },
    discordDelivery: { findMany, update },
  } as unknown as PrismaService;

  const postMessage = jest.fn(async () => ({ ok: botOk, status: 200 }));
  const bot = { postMessage } as unknown as DiscordBotClient;
  const embeds = new DiscordEmbedBuilderService();
  const svc = new DiscordLateReportService(prisma, bot, embeds);
  return { svc, postMessage, findMany, update };
};

const legacySnapshotFor = (hours: number) =>
  JSON.stringify({
    projectName: 'Legacy Snapshot Project',
    hours,
    reportDate: '2026-11-10T00:00:00.000Z',
    text: 'confidential body that MUST NOT reach the PMS card',
    submittedAt: '2026-11-10T19:04:12.000Z',
  });

describe('DiscordLateReportService.tick — compact PMS card', () => {
  const firstEmbed = (postMessage: ReturnType<typeof jest.fn>) => {
    const call = postMessage.mock.calls[0] as unknown as [
      {
        embeds: Array<Record<string, unknown>>;
        allowedMentions?: { parse: string[] };
      },
    ];
    return { call: call[0], embed: call[0].embeds[0] };
  };

  it('sends a late card with LEGACY_BLUE for hours > 6, Hours + For day only', async () => {
    const { svc, postMessage } = makeStubs([
      {
        id: 'row-blue',
        status: DiscordDeliveryStatus.PENDING,
        attempts: 0,
        periodKey: legacySnapshotFor(9),
      },
    ]);
    await svc.tick();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const { embed } = firstEmbed(postMessage) as unknown as {
      embed: {
        color: number;
        title: string;
        description?: string;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
      };
    };
    expect(embed.color).toBe(LEGACY_BLUE);
    expect(embed.title).toBe('⏰ Late report — Legacy Snapshot Project');
    expect(embed.description).toBeUndefined();
    expect(embed.fields?.map((f) => f.name)).toEqual([
      '🕒 Hours',
      '📅 For day',
    ]);
    expect(
      embed.fields?.find((f) => f.name === '📅 For day')?.value,
    ).toBe('2026-11-10');
    const asJson = JSON.stringify(embed);
    expect(asJson).not.toContain('confidential body');
    expect(asJson).not.toContain('Submitted at');
    expect(asJson).not.toContain('Details');
  });

  it('sends LEGACY_RED when hours ≤ 6 (6.00 → red, strict `>`)', async () => {
    const { svc, postMessage } = makeStubs([
      {
        id: 'row-red',
        status: DiscordDeliveryStatus.PENDING,
        attempts: 0,
        periodKey: legacySnapshotFor(6),
      },
    ]);
    await svc.tick();
    const { embed } = firstEmbed(postMessage) as unknown as {
      embed: { color: number };
    };
    expect(embed.color).toBe(LEGACY_RED);
  });

  it('does not re-send SENT rows (findMany scope excludes them)', async () => {
    const { svc, postMessage, findMany } = makeStubs([
      {
        id: 'row-sent',
        status: DiscordDeliveryStatus.SENT,
        attempts: 1,
        periodKey: legacySnapshotFor(10),
      },
    ]);
    await svc.tick();
    expect(postMessage).not.toHaveBeenCalled();
    const findManyCall = findMany.mock.calls[0] as unknown as [
      { where: { status: DiscordDeliveryStatus } },
    ];
    expect(findManyCall[0].where.status).toBe(DiscordDeliveryStatus.PENDING);
  });

  it('on success flips the row to SENT with incremented attempts', async () => {
    const { svc, update } = makeStubs([
      {
        id: 'row-ok',
        status: DiscordDeliveryStatus.PENDING,
        attempts: 2,
        periodKey: legacySnapshotFor(8),
      },
    ]);
    await svc.tick();
    expect(update).toHaveBeenCalledTimes(1);
    const updateCall = update.mock.calls[0] as unknown as [
      {
        where: { id: string };
        data: {
          status: DiscordDeliveryStatus;
          attempts: number;
        };
      },
    ];
    expect(updateCall[0].where.id).toBe('row-ok');
    expect(updateCall[0].data.status).toBe(DiscordDeliveryStatus.SENT);
    expect(updateCall[0].data.attempts).toBe(3);
  });

  it('tolerates both MANUAL-origin and Discord-origin snapshots (same late shape)', async () => {
    const manualSnapshot = JSON.stringify({
      projectName: 'Minimal Manual',
      hours: 7,
      reportDate: '2026-11-10T00:00:00.000Z',
      text: '',
      submittedAt: '2026-11-10T19:30:00.000Z',
    });
    const discordSnapshot = legacySnapshotFor(7);
    const makeFor = (periodKey: string) =>
      makeStubs([
        {
          id: 'row',
          status: DiscordDeliveryStatus.PENDING,
          attempts: 0,
          periodKey,
        },
      ]);
    const first = makeFor(manualSnapshot);
    const second = makeFor(discordSnapshot);
    await first.svc.tick();
    await second.svc.tick();
    const manual = firstEmbed(first.postMessage) as unknown as {
      embed: {
        color: number;
        title: string;
        fields?: Array<{ name: string; value: string }>;
      };
    };
    const discord = firstEmbed(second.postMessage) as unknown as {
      embed: {
        color: number;
        title: string;
        fields?: Array<{ name: string; value: string }>;
      };
    };
    // Same color, same field names, same ordering.
    expect(manual.embed.color).toBe(LEGACY_BLUE);
    expect(discord.embed.color).toBe(LEGACY_BLUE);
    expect(manual.embed.fields?.map((f) => f.name)).toEqual([
      '🕒 Hours',
      '📅 For day',
    ]);
    expect(discord.embed.fields?.map((f) => f.name)).toEqual([
      '🕒 Hours',
      '📅 For day',
    ]);
  });

  it('posts with allowed_mentions pinned so project name cannot ping', async () => {
    const { svc, postMessage } = makeStubs([
      {
        id: 'row-mentions',
        status: DiscordDeliveryStatus.PENDING,
        attempts: 0,
        periodKey: legacySnapshotFor(10),
      },
    ]);
    await svc.tick();
    const { call } = firstEmbed(postMessage);
    expect(call.allowedMentions).toEqual({ parse: [] });
  });
});
