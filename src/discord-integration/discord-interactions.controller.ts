import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { verifyDiscordSignature } from './ed25519';
import { DiscordReportService } from './discord-report.service';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';

/** Discord interaction / response constants. */
const INT_TYPE_PING = 1;
const INT_TYPE_APPLICATION_COMMAND = 2;
const RESP_PONG = 1;
const RESP_MESSAGE = 4;
const RESP_DEFERRED_MESSAGE = 5;
const FLAG_EPHEMERAL = 64;

/**
 * Discord Interactions endpoint.
 *
 * **Lifecycle contract**:
 *   1. Verify Ed25519 signature against raw body. Invalid → 401.
 *   2. Return `type: 5` deferred, ephemeral — this is the only
 *      response that must happen within Discord's 3-second deadline.
 *      Nothing else is awaited inline.
 *   3. In the background, run the actual work (DB write, dup check,
 *      author/project resolution). When it finishes:
 *        • success → POST a public follow-up with the embed into the
 *          same channel via the interaction webhook, then PATCH
 *          @original with a short ephemeral confirmation.
 *        • failure → PATCH @original with the human-readable error.
 *          No public message is posted. The invoker sees the error
 *          only.
 *   4. Interaction tokens are never logged or stored. They stay in
 *      memory for the duration of the follow-up call only.
 *
 * The webhook endpoint is public — the Ed25519 verification IS the
 * authorization check. It is listed in PUBLIC_ALLOWLIST in the
 * authorization-contract test.
 */
@Controller('webhooks/discord')
export class DiscordInteractionsController {
  private readonly logger = new Logger(DiscordInteractionsController.name);

  constructor(
    private readonly reports: DiscordReportService,
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
    private readonly embeds: DiscordEmbedBuilderService,
  ) {}

  @Post('interactions')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature-ed25519') signature: string | undefined,
    @Headers('x-signature-timestamp') timestamp: string | undefined,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) throw new UnauthorizedException('raw body unavailable');
    const publicKey = process.env.DISCORD_PUBLIC_KEY ?? '';
    const ok = verifyDiscordSignature({
      publicKeyHex: publicKey,
      signatureHex: signature ?? '',
      timestamp: timestamp ?? '',
      rawBody,
    });
    if (!ok) throw new UnauthorizedException('invalid request signature');

    let payload: InteractionPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as InteractionPayload;
    } catch {
      throw new BadRequestException('invalid JSON');
    }

    if (payload.type === INT_TYPE_PING) {
      return { type: RESP_PONG };
    }

    if (
      payload.type !== INT_TYPE_APPLICATION_COMMAND ||
      (payload.data?.name ?? '') !== 'report'
    ) {
      // Unknown command — immediate ephemeral; no deferred work.
      return this.immediateEphemeral('Unknown command.');
    }

    const token = payload.token;
    if (!token) {
      // Discord guarantees a token on type-2; defensive guard only.
      return this.immediateEphemeral('❌ Missing interaction token.');
    }

    // Start the async work; its promise is intentionally not awaited.
    // The response must leave within the 3-second deadline.
    void this.processCommand(payload).catch((err) => {
      // Never surface interaction tokens into the log.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`report processing crashed: ${this.scrub(msg)}`);
    });

    return {
      type: RESP_DEFERRED_MESSAGE,
      data: { flags: FLAG_EPHEMERAL },
    };
  }

  // ─── Background work ────────────────────────────────────────────

  private async processCommand(payload: InteractionPayload): Promise<void> {
    const token = payload.token!;
    const options = Object.fromEntries(
      (payload.data?.options ?? []).map((o) => [o.name, o.value]),
    );
    const hoursValue = options['hours'];
    const textValue = options['text'];
    const channelId = payload.channel_id ?? '';
    const author = payload.member?.user ?? payload.user ?? {};
    const authorName = author.global_name ?? author.username ?? 'Developer';
    const discordUserId = author.id ?? '';

    if (!channelId) return this.replyError(token, '❌ Could not read the channel id.');
    if (!discordUserId) return this.replyError(token, '❌ Could not read your Discord user id.');

    if (typeof hoursValue !== 'number' || Number.isNaN(hoursValue)) {
      return this.replyError(token, '❌ Hours must be a number.');
    }
    if (hoursValue <= 0 || hoursValue > 24) {
      return this.replyError(token, '❌ Hours must be between 0 and 24.');
    }
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text) return this.replyError(token, '❌ Please describe what was done in the text field.');
    if (text.length > 2048) return this.replyError(token, '❌ Text is longer than 2048 characters.');

    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { cutoffHour: true, timezone: true, dailyDigestAt: true },
    });
    if (!profile) {
      return this.replyError(
        token,
        '⚠️ Discord integration is not activated. Ask an admin to activate a profile.',
      );
    }

    let result: Awaited<ReturnType<DiscordReportService['createFromDiscord']>>;
    try {
      result = await this.reports.createFromDiscord({
        discordChannelId: channelId,
        discordUserId,
        discordUsername: authorName,
        hours: hoursValue,
        text,
        now: new Date(),
        cutoffHour: profile.cutoffHour,
        timezone: profile.timezone,
        dailyDigestAt: profile.dailyDigestAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save the report.';
      this.logger.warn(`report rejected: ${this.scrub(msg)}`);
      return this.replyError(token, `ℹ️ ${msg}`);
    }

    const embed = this.embeds.reportEmbed({
      projectName: result.projectName,
      authorName: result.discordUsername,
      hours: result.hours,
      reportDate: result.reportDate,
      text,
      isLate: result.isLate,
    });

    // Lifecycle: the first HTTP call after a deferred interaction
    // response is treated by Discord as *Edit Original Interaction
    // Response* and inherits the defer's ephemeral flag. Because our
    // defer is ephemeral, we MUST close the original ephemeral slot
    // FIRST (via editOriginal) before posting the public embed via
    // followup — otherwise the embed lands inside the ephemeral
    // bubble and only the invoker sees it.
    const okContent = result.isLate
      ? `✅ Report saved for ${result.projectName} on ${this.isoDate(result.reportDate)} (marked LATE).`
      : `✅ Report saved for ${result.projectName} on ${this.isoDate(result.reportDate)}.`;
    const editResp = await this.bot.editOriginal({
      interactionToken: token,
      content: okContent,
    });
    if (!editResp.ok) {
      this.logger.warn(
        `editOriginal (confirmation) failed [${editResp.status}]: ${this.scrub(editResp.message)}`,
      );
      // Discord drops ephemeral updates silently sometimes; the row
      // is already in the DB. We still try to post the public embed.
    }

    const publicPost = await this.bot.followup({
      interactionToken: token,
      embeds: [embed],
      // No ephemeral flag — this followup is intentionally public.
    });
    if (!publicPost.ok) {
      this.logger.warn(
        `public followup failed [${publicPost.status}]: ${this.scrub(publicPost.message)}`,
      );
      // Report is already committed; replace the ephemeral confirm
      // with a warning that the public card didn't go out so the
      // invoker knows to re-post or escalate. We do NOT retry here
      // and do NOT roll back the ProjectReport.
      const warn = await this.bot.editOriginal({
        interactionToken: token,
        content: `${okContent}\n⚠️ The public report card could not be posted to this channel; ask an admin to repost or check channel permissions.`,
      });
      if (!warn.ok) {
        this.logger.warn(
          `editOriginal (warning) failed [${warn.status}]: ${this.scrub(warn.message)}`,
        );
      }
    }
  }

  private async replyError(token: string, message: string): Promise<void> {
    const r = await this.bot.editOriginal({ interactionToken: token, content: message });
    if (!r.ok) {
      this.logger.warn(`editOriginal failed [${r.status}]: ${this.scrub(r.message)}`);
    }
  }

  private immediateEphemeral(content: string) {
    return {
      type: RESP_MESSAGE,
      data: { content, flags: FLAG_EPHEMERAL },
    };
  }

  private scrub(s: string): string {
    // Interaction tokens are long opaque strings — be belt-and-braces
    // in case something tries to log one before it is cleared. We
    // also mask bot tokens and the interaction-token slug that may
    // appear inside echoed webhook URLs.
    return s
      .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
      .replace(/\/webhooks\/(\d{17,20})\/[^\/\s]+/g, '/webhooks/$1/<redacted>')
      .slice(0, 300);
  }

  private isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}

interface InteractionPayload {
  type?: number;
  token?: string;
  data?: { name?: string; options?: Array<{ name: string; value: unknown }> };
  channel_id?: string;
  member?: { user?: { id?: string; global_name?: string; username?: string } };
  user?: { id?: string; global_name?: string; username?: string };
}
