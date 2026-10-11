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
            matchScore: true,
            decision: true,
            priority: true,
            budget: true,
            totalSpent: true,
            country: true,
            postedAt: true,
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

  /**
   * Compact Job-Post alert embed, matching the final previewed format.
   * Rules:
   *   - colour bar by verdict (approve emerald, maybe amber, decline
   *     red). Decline shouldn't reach this builder because the rule
   *     filter in NotificationService drops it, but the branch is
   *     here so a stray payload doesn't fall back to a default blue.
   *   - title is the vacancy name as-is (no "fire" prefix).
   *   - one Verdict field, multi-line. Lines are dropped individually
   *     when their data is missing; no placeholder values, no
   *     "Unknown", no "null".
   *   - Links field - CRM link rendered when a jobPostId and
   *     FRONTEND_URL are both present; the Upwork link only when
   *     jobUrl is present. Field is skipped if neither renders.
   *   - NO description (full rawText), NO AI reasoning field, NO
   *     footer (internal eventId was leaking into channel chat).
   */
  private buildEmbed(
    _eventId: string,
    payload: Exclude<ReturnType<typeof this.parsePayload>, null>,
    jobPost:
      | ({
          budget: string | null;
          totalSpent: number | null;
          country: string | null;
          postedAt: Date | null;
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
    const color = colorForDecision(decision);

    // ── Verdict block (compact, one multi-line field) ──────────────
    const verdictHead = [
      `**${score}**/100`,
      decision || null,
      priority || null,
    ]
      .filter(Boolean)
      .join(' · ');

    const verdictLines: string[] = [verdictHead];
    if (jobPost?.budget) {
      verdictLines.push(`💰 ${jobPost.budget}`);
    }
    const clientBits: string[] = [];
    if (jobPost?.totalSpent != null) {
      clientBits.push(`Total spent $${Math.round(jobPost.totalSpent).toLocaleString('en-US')}`);
    }
    if (jobPost?.country) {
      const flag = flagEmojiForCountry(jobPost.country);
      clientBits.push(`${flag ? flag + ' ' : ''}${jobPost.country}`);
    }
    if (clientBits.length > 0) {
      verdictLines.push(`👤 ${clientBits.join(' · ')}`);
    }
    if (jobPost?.postedAt) {
      const unix = Math.floor(jobPost.postedAt.getTime() / 1000);
      verdictLines.push(`🕐 posted <t:${unix}:R>`);
    }

    // ── Links block ────────────────────────────────────────────────
    const linkBits: string[] = [];
    const crmBase = (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
    if (crmBase && (jobPost?.id || payload.jobPostId)) {
      const jpId = jobPost?.id ?? payload.jobPostId;
      linkBits.push(`[Open in CRM](${crmBase}/job-posts/preview/${jpId})`);
    }
    if (url) {
      linkBits.push(`[Open on Upwork](${url})`);
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = [
      {
        name: 'Verdict',
        value: truncate(verdictLines.join('\n'), 1024),
        inline: false,
      },
    ];
    if (linkBits.length > 0) {
      fields.push({
        name: 'Links',
        value: truncate(linkBits.join(' · '), 1024),
        inline: false,
      });
    }

    const embed: Record<string, unknown> = {
      title,
      color,
      fields,
    };
    if (url) embed.url = url;
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

/**
 * Verdict → embed bar colour. Matches the shades used in the final
 * previewed format:
 *   approve → #22c55e emerald, maybe → #f59e0b amber,
 *   decline → #dc2626 red (safety fallback — the NotificationService
 *   rule already drops decline before this builder is reached).
 */
function colorForDecision(decision: string): number {
  switch (decision) {
    case 'approve':
      return 0x22c55e;
    case 'maybe':
      return 0xf59e0b;
    case 'decline':
      return 0xdc2626;
    default:
      // Unknown verdict shouldn't reach us; use amber so it stands
      // out from the approve/decline tones without pretending to be
      // either.
      return 0xf59e0b;
  }
}

/**
 * Converts an ISO-3166 alpha-2 code into the regional-indicator
 * flag emoji. Returns an empty string when the input is anything but
 * a two-letter code (e.g. "United States" → ""). Callers render the
 * country name separately — the flag is purely decorative.
 */
function flagEmojiForCountry(country: string): string {
  if (country.length !== 2) return '';
  const code = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    0x1f1e6 + code.charCodeAt(0) - 65,
    0x1f1e6 + code.charCodeAt(1) - 65,
  );
}
