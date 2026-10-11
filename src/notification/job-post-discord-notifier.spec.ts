/**
 * JobPostDiscordNotifierService — contract regression.
 *
 * Covers:
 *   - active TEST → embed goes to TEST.salesChannelId;
 *   - after atomic swap to PRODUCTION the same code targets PRODUCTION's
 *     salesChannelId (no code change / env flip required);
 *   - no active profile → retryable NoDeliveryTargetError;
 *   - salesChannelId null on the active profile → retryable
 *     NoDeliveryTargetError;
 *   - DiscordBotClient.postMessage returning ok=false (403, 429, 5xx) →
 *     retryable DiscordDeliveryError;
 *   - DiscordBotClient.postMessage ok=true → send resolves (processor
 *     then flips NotificationDelivery to SENT);
 *   - allowedMentions is set to parse:[] (no @everyone / @role);
 *   - long title / description / fields are truncated to safe limits;
 *   - no legacy webhook sender is touched for JOB_POST_MATCH (verified
 *     at the processor layer in notification.processor spec, below).
 *
 * Prisma is driven live against local Postgres so we exercise the real
 * `discordProfile.findFirst({active:true})` + `jobPost.findUnique`
 * queries. Bot client is a stub.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { DiscordProfileName, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  DiscordDeliveryError,
  JobPostDiscordNotifierService,
  NoDeliveryTargetError,
} from './job-post-discord-notifier.service';
import type { DiscordBotClient } from '../discord-integration/discord-bot.client';
import type { PrismaService } from '../prisma/prisma.service';

const prisma = new PrismaClient();
const TAG = `jp-notify-${randomUUID().slice(0, 8)}`;

function makeBot(resp: { ok: true; messageId: string } | { ok: false; status: number; message: string }) {
  const postMessage = jest.fn(async () => resp);
  const stub = { postMessage } as unknown as DiscordBotClient & {
    postMessage: jest.Mock;
  };
  return stub;
}

/* Preserve the full pre-test profile state (every mutable column) and
   restore it so other tests in the suite — notably
   `discord-safe-disable.spec.ts`, which counts "loud" per profile by
   looking at every channel/role id — are unaffected. */
let originalPosture: Array<{
  name: DiscordProfileName;
  active: boolean;
  salesChannelId: string | null;
  guildId: string | null;
  pmsChannelId: string | null;
  generalChannelId: string | null;
  opsChannelId: string | null;
  managerRoleId: string | null;
}> = [];

const createdJobPostIds: string[] = [];

beforeAll(async () => {
  originalPosture = await prisma.discordProfile.findMany({
    select: {
      name: true,
      active: true,
      salesChannelId: true,
      guildId: true,
      pmsChannelId: true,
      generalChannelId: true,
      opsChannelId: true,
      managerRoleId: true,
    },
    orderBy: { name: 'asc' },
  });
});

afterEach(async () => {
  if (createdJobPostIds.length) {
    await prisma.jobPost.deleteMany({ where: { id: { in: createdJobPostIds } } });
    createdJobPostIds.length = 0;
  }
});

afterAll(async () => {
  // Restore every profile column exactly as it was.
  for (const row of originalPosture) {
    await prisma.discordProfile.update({
      where: { name: row.name },
      data: {
        active: row.active,
        salesChannelId: row.salesChannelId,
        guildId: row.guildId,
        pmsChannelId: row.pmsChannelId,
        generalChannelId: row.generalChannelId,
        opsChannelId: row.opsChannelId,
        managerRoleId: row.managerRoleId,
      },
    });
  }
  await prisma.$disconnect();
});

async function activateOnly(
  name: DiscordProfileName,
  salesChannelId: string | null,
) {
  await prisma.$transaction([
    prisma.discordProfile.updateMany({ data: { active: false } }),
    prisma.discordProfile.update({
      where: { name },
      data: { active: true, salesChannelId },
    }),
  ]);
}

async function seedJobPost(opts: {
  title?: string;
  jobUrl?: string | null;
  budget?: string | null;
  totalSpent?: number | null;
  country?: string | null;
  postedAt?: Date | null;
  decision?: 'approve' | 'maybe' | 'decline';
  priority?: 'high' | 'medium' | 'low' | null;
  matchScore?: number;
}) {
  const jp = await prisma.jobPost.create({
    data: {
      providerJobId: `${TAG}_${Date.now()}_${Math.random()}`,
      rawText: 'raw text sample',
      rawPayload: {} as never,
      status: 'PROCESSED',
      scanner: 'vibe-worker',
      title: opts.title ?? 'Sample vacancy',
      // Use `in opts` so an explicit `null` means "no URL", while an
      // omitted key falls back to the sample URL.
      jobUrl: 'jobUrl' in opts ? opts.jobUrl : 'https://www.upwork.com/jobs/~abc',
      budget: opts.budget ?? null,
      totalSpent: opts.totalSpent ?? null,
      country: opts.country ?? null,
      postedAt: opts.postedAt ?? null,
      hSkillsKeywords: [],
      matchScore: opts.matchScore ?? 85,
      decision: opts.decision ?? 'approve',
      priority: 'priority' in opts ? opts.priority : 'high',
    },
    select: { id: true },
  });
  createdJobPostIds.push(jp.id);
  return jp.id;
}

function makePayload(jobPostId: string, overrides: Record<string, unknown> = {}) {
  return {
    jobPostId,
    score: 85,
    title: 'Sample vacancy',
    url: 'https://www.upwork.com/jobs/~abc',
    decision: 'approve',
    priority: 'high',
    rawText: 'short preview',
    ...overrides,
  };
}

describe('JobPostDiscordNotifierService — compact format', () => {
  it('Approve full data: emerald bar + single Verdict field + Links + no description/AI', async () => {
    const testChannel = '1111111111111111111';
    await activateOnly(DiscordProfileName.TEST, testChannel);
    const posted = new Date('2026-10-11T09:30:00Z');
    const jobPostId = await seedJobPost({
      budget: '$3,500 fixed · USD',
      totalSpent: 42180,
      country: 'US',
      postedAt: posted,
      decision: 'approve',
      priority: 'high',
      matchScore: 82,
    });
    const bot = makeBot({ ok: true, messageId: 'msg-1' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    process.env.FRONTEND_URL = 'https://admin.sargas.io';

    await svc.send('event-1', {
      jobPostId,
      score: 82,
      title: 'Sample vacancy',
      url: 'https://www.upwork.com/jobs/~abc',
      decision: 'approve',
      priority: 'high',
      rawText: 'short preview',
    });

    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    const args = bot.postMessage.mock.calls[0][0] as {
      channelId: string;
      embeds: Array<Record<string, unknown>>;
      allowedMentions: { parse: string[] };
    };
    expect(args.channelId).toBe(testChannel);
    expect(args.allowedMentions).toEqual({ parse: [] });
    expect(args.embeds).toHaveLength(1);
    const embed = args.embeds[0] as {
      title: string;
      url?: string;
      color: number;
      description?: string;
      fields: Array<{ name: string; value: string }>;
      footer?: unknown;
    };
    // Title has NO 🔥 prefix anymore.
    expect(embed.title).toBe('Sample vacancy');
    expect(embed.url).toBe('https://www.upwork.com/jobs/~abc');
    // Emerald (approve).
    expect(embed.color).toBe(0x22c55e);
    // Description + AI reasoning are gone, footer is gone.
    expect(embed.description).toBeUndefined();
    expect(embed.footer).toBeUndefined();
    // Exactly two fields: Verdict + Links.
    const names = embed.fields.map((f) => f.name);
    expect(names).toEqual(['Verdict', 'Links']);
    expect(names).not.toContain('AI verdict');
    expect(names).not.toContain('Skills');
    expect(names).not.toContain('Client');

    const verdict = embed.fields.find((f) => f.name === 'Verdict')!.value;
    expect(verdict.startsWith('**82**/100 · approve · high')).toBe(true);
    expect(verdict).toContain('💰 $3,500 fixed · USD');
    expect(verdict).toContain('👤 Total spent $42,180');
    expect(verdict).toContain('🇺🇸 US');
    expect(verdict).toContain(`🕐 posted <t:${Math.floor(posted.getTime() / 1000)}:R>`);

    const links = embed.fields.find((f) => f.name === 'Links')!.value;
    expect(links).toContain(`[Open in CRM](https://admin.sargas.io/job-posts/preview/${jobPostId})`);
    expect(links).toContain('[Open on Upwork](https://www.upwork.com/jobs/~abc)');
  });

  it('Maybe with missing optional data: amber bar, Verdict shows only present rows, no Upwork link when jobUrl missing', async () => {
    const testChannel = '1212121212121212121';
    await activateOnly(DiscordProfileName.TEST, testChannel);
    const jobPostId = await seedJobPost({
      jobUrl: null,
      budget: '$35–$55 /hr · USD',
      totalSpent: null,
      country: null,
      postedAt: null,
      decision: 'maybe',
      priority: null,
      matchScore: 64,
    });
    const bot = makeBot({ ok: true, messageId: 'msg-2' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    process.env.FRONTEND_URL = 'https://admin.sargas.io';

    await svc.send('event-2', {
      jobPostId,
      score: 64,
      title: 'Shopify theme refactor',
      url: null,
      decision: 'maybe',
      priority: null,
      rawText: 'short preview',
    });

    const embed = (bot.postMessage.mock.calls[0][0] as {
      embeds: Array<Record<string, unknown>>;
    }).embeds[0] as {
      title: string;
      color: number;
      description?: string;
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.title).toBe('Shopify theme refactor');
    expect(embed.color).toBe(0xf59e0b);
    expect(embed.description).toBeUndefined();

    const verdict = embed.fields.find((f) => f.name === 'Verdict')!.value;
    expect(verdict.startsWith('**64**/100 · maybe')).toBe(true);
    expect(verdict).not.toContain('null');
    expect(verdict).not.toContain('Unknown');
    expect(verdict).toContain('💰 $35–$55 /hr · USD');
    // Client row absent (no totalSpent AND no country).
    expect(verdict).not.toContain('👤');
    // Posted row absent (no postedAt).
    expect(verdict).not.toContain('🕐');

    const links = embed.fields.find((f) => f.name === 'Links');
    // CRM link still rendered; no Upwork link because jobUrl is null.
    expect(links?.value).toContain('[Open in CRM]');
    expect(links?.value).not.toContain('[Open on Upwork]');
  });

  it('Minimal (no budget/client/posted): Verdict is a single headline line, Links only has CRM', async () => {
    const testChannel = '1313131313131313131';
    await activateOnly(DiscordProfileName.TEST, testChannel);
    const jobPostId = await seedJobPost({
      jobUrl: null,
      budget: null,
      totalSpent: null,
      country: null,
      postedAt: null,
      decision: 'approve',
      priority: null,
      matchScore: 71,
      title: 'Zapier integration',
    });
    const bot = makeBot({ ok: true, messageId: 'msg-3' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    process.env.FRONTEND_URL = 'https://admin.sargas.io';

    await svc.send('event-3', {
      jobPostId,
      score: 71,
      title: 'Zapier integration',
      url: null,
      decision: 'approve',
      priority: null,
      rawText: null,
    });

    const embed = (bot.postMessage.mock.calls[0][0] as {
      embeds: Array<Record<string, unknown>>;
    }).embeds[0] as {
      title: string;
      color: number;
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.title).toBe('Zapier integration');
    expect(embed.color).toBe(0x22c55e);
    const verdict = embed.fields.find((f) => f.name === 'Verdict')!.value;
    expect(verdict).toBe('**71**/100 · approve');
    const links = embed.fields.find((f) => f.name === 'Links');
    expect(links?.value).toBe(`[Open in CRM](https://admin.sargas.io/job-posts/preview/${jobPostId})`);
  });

  it('after atomic PRODUCTION activation → same code targets PRODUCTION.salesChannelId', async () => {
    const prodChannel = '2222222222222222222';
    await prisma.discordProfile.update({
      where: { name: DiscordProfileName.PRODUCTION },
      data: {
        salesChannelId: prodChannel,
        guildId: '1234567890123456',
        pmsChannelId: '1234567890123450',
        generalChannelId: '1234567890123451',
        opsChannelId: '1234567890123452',
        managerRoleId: '1234567890123453',
      },
    });
    await activateOnly(DiscordProfileName.PRODUCTION, prodChannel);
    const jobPostId = await seedJobPost({});
    const bot = makeBot({ ok: true, messageId: 'msg-prod' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await svc.send('event-prod', makePayload(jobPostId));
    const args = bot.postMessage.mock.calls[0][0] as { channelId: string };
    expect(args.channelId).toBe(prodChannel);
  });
});

describe('JobPostDiscordNotifierService — retryable failure cases', () => {
  it('throws NoDeliveryTargetError when no profile is active', async () => {
    await prisma.discordProfile.updateMany({ data: { active: false } });
    const jobPostId = await seedJobPost({});
    const bot = makeBot({ ok: true, messageId: 'nope' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await expect(
      svc.send('event-no-active', makePayload(jobPostId)),
    ).rejects.toBeInstanceOf(NoDeliveryTargetError);
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  it('throws NoDeliveryTargetError when active profile has no salesChannelId', async () => {
    await activateOnly(DiscordProfileName.TEST, null);
    const jobPostId = await seedJobPost({});
    const bot = makeBot({ ok: true, messageId: 'nope' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await expect(
      svc.send('event-no-channel', makePayload(jobPostId)),
    ).rejects.toBeInstanceOf(NoDeliveryTargetError);
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  it('throws DiscordDeliveryError on DiscordBotClient ok=false (403/429/5xx)', async () => {
    await activateOnly(DiscordProfileName.TEST, '3333333333333333333');
    const jobPostId = await seedJobPost({});
    const bot = makeBot({ ok: false, status: 429, message: 'rate limited' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await expect(
      svc.send('event-429', makePayload(jobPostId)),
    ).rejects.toBeInstanceOf(DiscordDeliveryError);
  });
});

describe('JobPostDiscordNotifierService — safety caps on embed content', () => {
  it('truncates an overly long title to the Discord 256-char cap', async () => {
    await activateOnly(DiscordProfileName.TEST, '4444444444444444444');
    const absurdlyLongTitle = 'T'.repeat(900);
    const jobPostId = await seedJobPost({ title: absurdlyLongTitle });
    const bot = makeBot({ ok: true, messageId: 'ok' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await svc.send(
      'event-long',
      makePayload(jobPostId, { title: absurdlyLongTitle }),
    );
    const embed = (bot.postMessage.mock.calls[0][0] as { embeds: Array<{ title: string }> })
      .embeds[0];
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.title.endsWith('…')).toBe(true);
  });

  it('never includes `description` (full rawText) — the compact format drops it entirely', async () => {
    await activateOnly(DiscordProfileName.TEST, '5555555555555555555');
    const jobPostId = await seedJobPost({});
    const bot = makeBot({ ok: true, messageId: 'ok' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    const payload = makePayload(jobPostId, { rawText: 'x'.repeat(10_000) });
    await svc.send('event-desc', payload);
    const embed = (bot.postMessage.mock.calls[0][0] as {
      embeds: Array<{ description?: string }>;
    }).embeds[0];
    expect(embed.description).toBeUndefined();
  });
});
