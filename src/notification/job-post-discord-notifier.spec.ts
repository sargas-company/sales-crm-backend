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
  location?: string | null;
  budget?: string | null;
  totalSpent?: number | null;
  hireRate?: number | null;
  avgRatePaid?: number | null;
  skills?: string[];
  rawPayload?: unknown;
  aiResponse?: unknown;
}) {
  const jp = await prisma.jobPost.create({
    data: {
      providerJobId: `${TAG}_${Date.now()}_${Math.random()}`,
      rawText: 'raw text sample',
      rawPayload: (opts.rawPayload ?? {}) as never,
      status: 'PROCESSED',
      scanner: 'vibe-worker',
      title: opts.title ?? 'Sample vacancy',
      jobUrl: opts.jobUrl ?? 'https://www.upwork.com/jobs/~abc',
      location: opts.location ?? null,
      budget: opts.budget ?? null,
      totalSpent: opts.totalSpent ?? null,
      hireRate: opts.hireRate ?? null,
      avgRatePaid: opts.avgRatePaid ?? null,
      hSkillsKeywords: opts.skills ?? [],
      aiResponse: opts.aiResponse as never,
      matchScore: 85,
      decision: 'approve',
      priority: 'high',
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

describe('JobPostDiscordNotifierService — happy path', () => {
  it('TEST active → embed goes to TEST.salesChannelId with parse:[] mentions', async () => {
    const testChannel = '1111111111111111111';
    await activateOnly(DiscordProfileName.TEST, testChannel);
    const jobPostId = await seedJobPost({
      budget: 'USD 60–90/hr',
      location: 'United States',
      totalSpent: 125000,
      hireRate: 0.85,
      skills: ['Node.js', 'Stripe'],
      rawPayload: {
        job: { type: 'hourly', duration: '3+ months', experienceLevel: 'expert' },
        client: { rating: 4.9, paymentVerified: true, location: 'US' },
        match: { reasoning: 'High fit; Stripe + marketplace.' },
      },
      aiResponse: {
        gatekeeper: { fit: true, reason: 'Node + Stripe' },
        evaluation: { reasoning: 'Strong product-side rebuild.' },
      },
    });
    const bot = makeBot({ ok: true, messageId: 'msg-1' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );

    await svc.send('event-1', makePayload(jobPostId));

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
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.title).toMatch(/Sample vacancy/);
    expect(embed.url).toBe('https://www.upwork.com/jobs/~abc');
    const fieldNames = embed.fields.map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(['Score', 'Decision', 'Priority', 'Budget / Type', 'Location', 'Client', 'Skills', 'AI verdict']),
    );
    const skillsField = embed.fields.find((f) => f.name === 'Skills');
    expect(skillsField?.value).toContain('Node.js');
    const clientField = embed.fields.find((f) => f.name === 'Client');
    expect(clientField?.value).toContain('verified');
    expect(clientField?.value).toContain('rating: 4.90');
    expect(clientField?.value).toContain('spent: $125000');
    expect(clientField?.value).toContain('85%');
    const ai = embed.fields.find((f) => f.name === 'AI verdict');
    expect(ai?.value).toContain('product-side rebuild');
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
  it('truncates an overly long title and preserves the embed under Discord limits', async () => {
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
    expect(embed.title.length).toBeLessThanOrEqual(256 + 3); // "🔥 " = 2 UTF-16 units + space
    expect(embed.title.endsWith('…')).toBe(true);
  });

  it('truncates a long rawText description', async () => {
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
    expect(embed.description!.length).toBeLessThanOrEqual(2000);
  });

  it('truncates a very long skills list down to the field 1024-char limit', async () => {
    await activateOnly(DiscordProfileName.TEST, '6666666666666666666');
    const skills = Array.from({ length: 200 }).map(
      (_, i) => `skill-with-a-fairly-long-name-${i}`,
    );
    const jobPostId = await seedJobPost({ skills });
    const bot = makeBot({ ok: true, messageId: 'ok' });
    const svc = new JobPostDiscordNotifierService(
      prisma as unknown as PrismaService,
      bot,
    );
    await svc.send('event-skills', makePayload(jobPostId));
    const embed = (bot.postMessage.mock.calls[0][0] as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    }).embeds[0];
    const skillsField = embed.fields.find((f) => f.name === 'Skills')!;
    expect(skillsField.value.length).toBeLessThanOrEqual(1024);
  });
});
