import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from '../discord-integration/discord-bot.client';

/**
 * Scanner Core delivery path for JOB_POST_MATCH NotificationEvents.
 *
 * Routes the embed through the active DiscordProfile's `salesChannelId`
 * via `DiscordBotClient.postMessage`. The active profile is read every
 * call, so an atomic swap TEST ↔ PRODUCTION in Settings takes effect
 * immediately without a backend restart and without any env fiddling.
 *
 * `send` throws on every "not deliverable right now" case so the
 * existing NotificationProcessorService retry path (NotificationDelivery
 * stays non-SENT, BullMQ exponential backoff) kicks in. Nothing is
 * silently skipped once a NotificationEvent has been enqueued.
 */
@Injectable()
export class JobPostDiscordNotifierService {
  private readonly logger = new Logger(JobPostDiscordNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
  ) {}

  async send(eventId: string, payload: unknown): Promise<void> {
    const parsed = this.parsePayload(payload);
    if (!parsed) {
      throw new Error(
        `Invalid JOB_POST_MATCH payload for event ${eventId}`,
      );
    }

    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { name: true, salesChannelId: true },
    });
    if (!profile) {
      throw new NoDeliveryTargetError(
        'No active DiscordProfile — scanner notifications cannot be delivered',
      );
    }
    if (!profile.salesChannelId) {
      throw new NoDeliveryTargetError(
        `Active DiscordProfile "${profile.name}" has no salesChannelId`,
      );
    }

    const jobPost = parsed.jobPostId
      ? await this.prisma.jobPost.findUnique({
          where: { id: parsed.jobPostId },
          select: {
            id: true,
            title: true,
            jobUrl: true,
            rawPayload: true,
            matchScore: true,
            decision: true,
            priority: true,
            location: true,
            budget: true,
            totalSpent: true,
            avgRatePaid: true,
            hireRate: true,
            hSkillsKeywords: true,
            aiResponse: true,
          },
        })
      : null;

    const embed = this.buildEmbed(eventId, parsed, jobPost);
    const resp = await this.bot.postMessage({
      channelId: profile.salesChannelId,
      embeds: [embed],
      // Hard-disable every @everyone, @here, @role and @user from
      // ever paging the channel — even if the vacancy text happens
      // to contain the sentinels. Discord treats parse:[] as "no
      // mentions are allowed at all", overriding content/text.
      allowedMentions: { parse: [] },
    });
    if (!resp.ok) {
      // Preserves the sanitised bot-token redaction + 300-char cap
      // from DiscordBotClient.wrapAxiosError; the thrown error is
      // stored in NotificationDelivery.error.
      throw new DiscordDeliveryError(
        `Discord postMessage ${resp.status}: ${resp.message}`,
      );
    }
    this.logger.log(
      `Delivered JOB_POST_MATCH event ${eventId} to profile ${profile.name} (channel ${profile.salesChannelId}), messageId=${resp.messageId}`,
    );
  }

  // ─── payload parse (strict) ─────────────────────────────────────

  private parsePayload(raw: unknown): {
    jobPostId: string | null;
    score: number;
    title: string | null;
    url: string | null;
    decision: string | null;
    priority: string | null;
    rawText: string | null;
  } | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.score !== 'number') return null;
    return {
      jobPostId: typeof p.jobPostId === 'string' ? p.jobPostId : null,
      score: p.score,
      title: typeof p.title === 'string' ? p.title : null,
      url: typeof p.url === 'string' ? p.url : null,
      decision: typeof p.decision === 'string' ? p.decision : null,
      priority: typeof p.priority === 'string' ? p.priority : null,
      rawText: typeof p.rawText === 'string' ? p.rawText : null,
    };
  }

  // ─── embed builder ──────────────────────────────────────────────

  private buildEmbed(
    eventId: string,
    payload: Exclude<ReturnType<typeof this.parsePayload>, null>,
    jobPost:
      | ({
          budget: string | null;
          location: string | null;
          totalSpent: number | null;
          avgRatePaid: number | null;
          hireRate: number | null;
          hSkillsKeywords: string[];
          aiResponse: unknown;
          rawPayload: unknown;
          title: string | null;
          jobUrl: string | null;
        } & { id: string })
      | null,
  ): Record<string, unknown> {
    const title = truncate(payload.title ?? jobPost?.title ?? 'No title', 256);
    const url = payload.url ?? jobPost?.jobUrl ?? undefined;
    const score = payload.score;
    const decision = payload.decision ?? '';
    const priority = payload.priority ?? '';
    const color =
      decision === 'approve'
        ? 0x57f287
        : decision === 'maybe'
          ? 0xfee75c
          : 0x5865f2;

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
    fields.push({
      name: 'Score',
      value: `${scoreEmoji(score)} ${score}%`,
      inline: true,
    });
    if (decision) fields.push({ name: 'Decision', value: decisionLabel(decision), inline: true });
    if (priority) fields.push({ name: 'Priority', value: priorityLabel(priority), inline: true });

    const vibePayload = (jobPost?.rawPayload ?? {}) as {
      job?: Record<string, unknown>;
      client?: Record<string, unknown>;
      match?: Record<string, unknown>;
    };
    const vibeJob = vibePayload.job ?? {};
    const vibeClient = vibePayload.client ?? {};
    const vibeMatch = vibePayload.match ?? {};

    // Economics line: budget + type + duration + experience level.
    const economics = [
      jobPost?.budget,
      typeof vibeJob.type === 'string' ? `type: ${vibeJob.type}` : null,
      typeof vibeJob.duration === 'string' ? `duration: ${vibeJob.duration}` : null,
      typeof vibeJob.hoursPerWeek === 'string' ? `hrs/wk: ${vibeJob.hoursPerWeek}` : null,
      typeof vibeJob.experienceLevel === 'string'
        ? `experience: ${vibeJob.experienceLevel}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (economics) {
      fields.push({ name: 'Budget / Type', value: truncate(economics, 1024), inline: false });
    }

    // Location (job vs client; both when available).
    const location =
      jobPost?.location ??
      (typeof vibeClient.location === 'string' ? vibeClient.location : null);
    if (location) {
      fields.push({ name: 'Location', value: truncate(location, 1024), inline: true });
    }

    // Client reputation line.
    const paymentVerified =
      typeof vibeClient.paymentVerified === 'boolean'
        ? vibeClient.paymentVerified
          ? 'verified ✓'
          : 'unverified ✗'
        : null;
    const rating =
      typeof vibeClient.rating === 'number' ? `rating: ${vibeClient.rating.toFixed(2)}` : null;
    const spent =
      jobPost?.totalSpent != null ? `spent: $${Math.round(jobPost.totalSpent)}` : null;
    const hireRate =
      jobPost?.hireRate != null ? `hire rate: ${formatHireRate(jobPost.hireRate)}` : null;
    const avgRate =
      jobPost?.avgRatePaid != null ? `avg rate: $${jobPost.avgRatePaid}/hr` : null;
    const clientLine = [paymentVerified, rating, spent, avgRate, hireRate].filter(Boolean).join(' · ');
    if (clientLine) {
      fields.push({ name: 'Client', value: truncate(clientLine, 1024), inline: false });
    }

    // Skills.
    const skills = jobPost?.hSkillsKeywords ?? [];
    if (skills.length) {
      fields.push({
        name: 'Skills',
        value: truncate(skills.join(', '), 1024),
        inline: false,
      });
    }

    // AI verdict / reasoning.
    const gatekeeperReason =
      typeof (jobPost?.aiResponse as { gatekeeper?: { reason?: string } } | null)?.gatekeeper
        ?.reason === 'string'
        ? (jobPost?.aiResponse as { gatekeeper?: { reason?: string } }).gatekeeper!.reason!
        : null;
    const evaluatorReasoning =
      typeof (jobPost?.aiResponse as { evaluation?: { reasoning?: string } } | null)?.evaluation
        ?.reasoning === 'string'
        ? (jobPost?.aiResponse as { evaluation?: { reasoning?: string } }).evaluation!
            .reasoning!
        : null;
    const vibeReasoning =
      typeof vibeMatch.reasoning === 'string' ? vibeMatch.reasoning : null;
    const verdict = evaluatorReasoning ?? gatekeeperReason ?? vibeReasoning;
    if (verdict) {
      fields.push({
        name: 'AI verdict',
        value: truncate(verdict, 1024),
        inline: false,
      });
    }

    // Description = short rawText. Capped at 4096 Discord-wise, but we
    // trim to 2000 to leave headroom for the rest of the embed.
    const description = payload.rawText ? truncate(payload.rawText, 2000) : undefined;

    const embed: Record<string, unknown> = {
      title: `🔥 ${title}`,
      color,
      fields: fields.slice(0, 25),
      footer: { text: `event ${eventId}` },
    };
    if (url) embed.url = url;
    if (description) embed.description = description;

    return embed;
  }
}

export class NoDeliveryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoDeliveryTargetError';
  }
}

export class DiscordDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordDeliveryError';
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function scoreEmoji(score: number): string {
  if (score >= 70) return '🟢';
  if (score >= 40) return '🟡';
  return '🔴';
}

function decisionLabel(decision: string): string {
  if (decision === 'approve') return '✅ approve';
  if (decision === 'maybe') return '🤔 maybe';
  if (decision === 'decline') return '❌ decline';
  return decision;
}

function priorityLabel(p: string): string {
  if (p === 'high') return '🔴 high';
  if (p === 'medium') return '🟡 medium';
  if (p === 'low') return '🟢 low';
  return p;
}

function formatHireRate(hr: number): string {
  // Vibe sends either 0–1 or 0–100 depending on source — normalize.
  const normalised = hr > 1 ? hr : hr * 100;
  return `${Math.round(normalised)}%`;
}
