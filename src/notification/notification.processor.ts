import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  NotificationChannel,
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '@prisma/client';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from '../discord-integration/discord-bot.client';
import { JobPostDiscordNotifierService } from './job-post-discord-notifier.service';
import { LiveEventsService } from '../live-events/live-events.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SEND,
} from './notification.constants';
import { parseCallReminderPayload } from './schemas/call-reminder.payload';
import { parseClientRequestPayload } from './schemas/client-request.payload';

@Injectable()
export class NotificationProcessorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationProcessorService.name);
  private connection: IORedis;
  private worker: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly bot: DiscordBotClient,
    private readonly jobPostNotifier: JobPostDiscordNotifierService,
    private readonly liveEvents: LiveEventsService,
  ) {}

  onModuleInit() {
    // Every runtime CRM notification path (JOB_POST_MATCH, CLIENT_REQUEST,
    // CALL_REMINDER) is now routed through the active DiscordProfile via
    // DiscordBotClient. The worker starts unconditionally; if the bot
    // token or active profile is missing the per-attempt send throws and
    // BullMQ's exponential backoff takes over.
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    const prefix = process.env.BULLMQ_PREFIX || undefined;
    this.worker = new Worker(NOTIFICATION_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 2,
      ...(prefix ? { prefix } : {}),
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log(`Worker for "${NOTIFICATION_QUEUE}" started`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== NOTIFICATION_SEND) {
      this.logger.warn(`Unknown job name: ${job.name}, skipping`);
      return;
    }

    const { eventId } = (job.data ?? {}) as { eventId?: string };

    if (!eventId) {
      this.logger.warn(`Job ${job.id} missing eventId, skipping`);
      return;
    }

    this.logger.log(`Job started for eventId=${eventId}`);

    const event = await this.prisma.notificationEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      this.logger.warn(`NotificationEvent ${eventId} not found, skipping`);
      return;
    }

    this.logger.log(`Event loaded: ${eventId} [${event.type}]`);

    await this.deliverDiscord(event.type, event.payload, eventId);
  }

  /**
   * Route an event to its Discord channel on the active DiscordProfile:
   *   - JOB_POST_MATCH → salesChannelId via JobPostDiscordNotifierService;
   *   - CLIENT_REQUEST → pmsChannelId via DiscordBotClient;
   *   - CALL_REMINDER → pmsChannelId via DiscordBotClient.
   *
   * The active profile is resolved on every send so an atomic swap
   * TEST ↔ PRODUCTION in Settings takes effect without a backend
   * restart. Missing active profile or channelId throws, so BullMQ
   * retries with the existing exponential backoff and the
   * NotificationDelivery row stays non-SENT.
   */
  private async deliverDiscord(
    type: string,
    payload: unknown,
    eventId: string,
  ): Promise<void> {
    if (type === 'JOB_POST_MATCH') {
      await this.recordAndSend(eventId, () =>
        this.jobPostNotifier.send(eventId, payload),
      );
      return;
    }

    const embed =
      type === 'CALL_REMINDER'
        ? this.buildCallReminderEmbed(payload, eventId)
        : type === 'CLIENT_REQUEST'
          ? await this.buildWebsiteRequestEmbed(payload)
          : type === 'CALL_SCHEDULED'
            ? await this.buildCallEmbed('scheduled', payload)
            : type === 'CALL_RESCHEDULED'
              ? await this.buildCallEmbed('rescheduled', payload)
              : type === 'CALL_CANCELLED'
                ? await this.buildCallEmbed('cancelled', payload)
                : null;

    if (!embed) {
      this.logger.warn(`No Discord builder for event type ${type}, skipping`);
      return;
    }

    // All Sales-section events ship without a role mention per the
    // agreed PMS format. Legacy CALL_REMINDER kept its own builder
    // which uses the generic PMS post + mention, but the format
    // decision applies there too — pass `suppressMentions: true`.
    const suppressMentions =
      type === 'CLIENT_REQUEST' ||
      type === 'CALL_REMINDER' ||
      type === 'CALL_SCHEDULED' ||
      type === 'CALL_RESCHEDULED' ||
      type === 'CALL_CANCELLED';

    await this.recordAndSend(eventId, () =>
      this.postToPmsChannel(eventId, embed, { suppressMentions }),
    );
  }

  /**
   * Resolve the active DiscordProfile and post an embed to its PMS
   * channel. Throws on every "cannot deliver right now" case so the
   * caller sees a retryable failure (NotificationDelivery stays
   * non-SENT, BullMQ retries).
   *
   * When the active profile has a `managerRoleId`, a `<@&roleId>`
   * prefix is added to the message content and the role id is the
   * only entry in `allowed_mentions.roles`; `parse: []` ensures no
   * `@everyone`, `@here`, or any other role/user id that might
   * appear inside the embed can page the channel. When no role is
   * configured, the message goes without a ping and `allowed_mentions`
   * stays `{ parse: [] }`.
   */
  private async postToPmsChannel(
    eventId: string,
    embed: Record<string, unknown>,
    opts: { suppressMentions?: boolean } = {},
  ): Promise<void> {
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { name: true, pmsChannelId: true, managerRoleId: true },
    });
    if (!profile) {
      throw new Error(
        `No active DiscordProfile — event ${eventId} cannot be delivered`,
      );
    }
    if (!profile.pmsChannelId) {
      throw new Error(
        `Active DiscordProfile "${profile.name}" has no pmsChannelId — event ${eventId} cannot be delivered`,
      );
    }
    // Sales-section events opt out of the manager-role ping per the
    // agreed PMS format. Legacy types (CALL_REMINDER / CLIENT_REQUEST
    // routed through here previously) now also opt out.
    const pingManager = !opts.suppressMentions && !!profile.managerRoleId;
    const content = pingManager ? `<@&${profile.managerRoleId}>` : undefined;
    const allowedMentions: Record<string, unknown> = pingManager
      ? { parse: [], roles: [profile.managerRoleId] }
      : { parse: [] };
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content,
      embeds: [embed],
      allowedMentions,
    });
    if (!resp.ok) {
      throw new Error(`Discord postMessage ${resp.status}: ${resp.message}`);
    }
    this.logger.log(
      `Delivered event ${eventId} to profile ${profile.name} (channel ${profile.pmsChannelId}), messageId=${resp.messageId}`,
    );
  }

  private buildCallReminderEmbed(
    payload: unknown,
    eventId: string,
  ): Record<string, unknown> | null {
    const p = parseCallReminderPayload(payload);

    if (!p) {
      this.logger.warn(`Invalid CALL_REMINDER payload for event ${eventId}`);
      return null;
    }

    const title =
      p.reminderType === '60min'
        ? `Call reminder — in 1 hour: ${p.callTitle}`
        : `Call reminder — in 10 minutes: ${p.callTitle}`;

    const ownerLabel =
      p.clientType === 'lead'
        ? 'Lead'
        : p.clientType === 'client'
          ? 'Client'
          : 'Client Request';

    const lines: string[] = [];
    lines.push(`**Who:** ${p.clientName || '—'} (${ownerLabel})`);
    lines.push(`**Kyiv:** ${p.kyivDateTime}`);
    if (p.clientTimezone && p.clientTimezone !== 'Europe/Kyiv' && p.clientTimezone !== 'Europe/Kiev') {
      lines.push(`**Client:** ${p.clientDateTime} (${p.clientTimezoneAbbr})`);
    }
    lines.push(`**Duration:** ${p.durationMin} min`);
    if (p.meetingUrl) lines.push(`**Meeting:** ${p.meetingUrl}`);
    const crmLink = this.callCrmLink(p.callId as string | undefined);
    if (crmLink) lines.push(`**CRM:** ${crmLink}`);

    return {
      title: truncate(title, 256),
      color: SALES_PMS_BLUE,
      fields: [
        { name: 'Call', value: truncate(lines.join('\n'), 1024), inline: false },
      ],
    };
  }

  private async buildWebsiteRequestEmbed(
    payload: unknown,
  ): Promise<Record<string, unknown> | null> {
    const p = parseClientRequestPayload(payload);
    if (!p) return null;

    const lines: string[] = [];
    const nameLine = p.company ? `**${p.name}** · ${p.company}` : `**${p.name}**`;
    lines.push(nameLine);
    const contactBits: string[] = [];
    if (p.email) contactBits.push(p.email);
    if (p.phone) contactBits.push(p.phone);
    if (contactBits.length > 0) lines.push(contactBits.join(' · '));
    if (p.services?.length) lines.push(`Services: ${p.services.join(', ')}`);
    if (p.message) {
      const snippet = p.message.replace(/\s+/g, ' ').trim();
      lines.push(
        snippet.length > 300 ? snippet.slice(0, 299) + '…' : snippet,
      );
    }
    const crmBase = this.frontendBase();
    if (crmBase && p.clientRequestId) {
      lines.push(
        `[Open in CRM](${crmBase}/client-requests/preview/${p.clientRequestId})`,
      );
    }

    return {
      title: 'New website request',
      color: SALES_PMS_BLUE,
      fields: [
        { name: 'Request', value: truncate(lines.join('\n'), 1024), inline: false },
      ],
    };
  }

  /**
   * Compact embed used by CALL_SCHEDULED / RESCHEDULED / CANCELLED.
   * All three events share the same layout — only the title changes
   * and (for rescheduled) a prior/next time line is added.
   */
  private async buildCallEmbed(
    kind: 'scheduled' | 'rescheduled' | 'cancelled',
    payload: unknown,
  ): Promise<Record<string, unknown> | null> {
    const p = payload as {
      callId?: string;
      oldScheduledAt?: string;
      newScheduledAt?: string;
    } | null;
    const callId = p?.callId;
    if (!callId) return null;

    const call = await this.prisma.clientCall.findUnique({
      where: { id: callId },
      include: {
        lead: { select: { firstName: true, lastName: true, companyName: true } },
        crmClient: { select: { firstName: true, lastName: true, company: true } },
      },
    });
    if (!call) return null;

    const owner =
      call.clientType === 'lead'
        ? {
            type: 'Lead',
            name:
              [call.lead?.firstName, call.lead?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim() || call.lead?.companyName || '—',
          }
        : {
            type: 'Client',
            name:
              [call.crmClient?.firstName, call.crmClient?.lastName]
                .filter(Boolean)
                .join(' ')
                .trim() || call.crmClient?.company || '—',
          };

    const kyivTime = formatInKyiv(call.scheduledAt);
    const clientTime =
      call.clientTimezone &&
      call.clientTimezone !== 'Europe/Kyiv' &&
      call.clientTimezone !== 'Europe/Kiev'
        ? formatInTz(call.scheduledAt, call.clientTimezone)
        : null;

    const lines: string[] = [];
    lines.push(`**${call.callTitle}**`);
    lines.push(`Who: ${owner.name} (${owner.type})`);
    if (kind === 'rescheduled' && p?.oldScheduledAt && p?.newScheduledAt) {
      const was = formatInKyiv(new Date(p.oldScheduledAt));
      const now = formatInKyiv(new Date(p.newScheduledAt));
      lines.push(`Time (Kyiv): ~~${was}~~ → **${now}**`);
    } else if (kind === 'cancelled') {
      lines.push(`Time (Kyiv): ~~${kyivTime}~~ · cancelled`);
    } else {
      lines.push(`Kyiv: **${kyivTime}**`);
    }
    if (clientTime) lines.push(`Client: ${clientTime}`);
    lines.push(`Duration: ${call.duration} min`);
    if (call.meetingUrl) lines.push(`Meeting: ${call.meetingUrl}`);
    const crmLink = this.callCrmLink(callId);
    if (crmLink) lines.push(`CRM: ${crmLink}`);

    const title =
      kind === 'scheduled'
        ? 'Call scheduled'
        : kind === 'rescheduled'
          ? 'Call rescheduled'
          : 'Call cancelled';

    return {
      title,
      color: SALES_PMS_BLUE,
      fields: [
        { name: 'Call', value: truncate(lines.join('\n'), 1024), inline: false },
      ],
    };
  }

  private frontendBase(): string {
    return (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
  }

  private callCrmLink(callId: string | undefined): string | null {
    if (!callId) return null;
    const base = this.frontendBase();
    if (!base) return null;
    return `${base}/client-calls/preview/${callId}`;
  }

  /**
   * Shared delivery-record bookkeeping used by every Discord sender.
   * Owns the SENT/FAILED transitions on NotificationDelivery.
   *   - idempotent: a prior SENT short-circuits before the sender
   *     runs again (no double send on a BullMQ retry);
   *   - PENDING is reset at the start of each attempt;
   *   - sender error → FAILED + rethrow (BullMQ retry picks up).
   */
  private async recordAndSend(
    eventId: string,
    send: () => Promise<void>,
  ): Promise<void> {
    const existing = await this.prisma.notificationDelivery.findFirst({
      where: { eventId, channel: NotificationChannel.DISCORD },
    });

    if (existing?.status === NotificationDeliveryStatus.SENT) {
      this.logger.log(
        `Duplicate skipped: delivery already SENT for event ${eventId}`,
      );
      return;
    }

    let delivery: NotificationDelivery;
    try {
      delivery = existing
        ? await this.prisma.notificationDelivery.update({
            where: { id: existing.id },
            data: { status: NotificationDeliveryStatus.PENDING },
          })
        : await this.prisma.notificationDelivery.create({
            data: {
              eventId,
              channel: NotificationChannel.DISCORD,
              status: NotificationDeliveryStatus.PENDING,
              failedAttempts: 0,
            },
          });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        this.logger.warn(
          `Duplicate delivery blocked by DB constraint for event ${eventId}`,
        );
        return;
      }
      throw err;
    }

    this.logger.log(`Delivery created: ${delivery.id} for event ${eventId}`);

    try {
      await send();

      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: { status: NotificationDeliveryStatus.SENT, sentAt: new Date() },
      });

      this.logger.log(`Delivery ${delivery.id} sent for event ${eventId}`);
      // Live tick for the scanner Discord-alerts card. Only on the
      // actual confirmed outcome — not when the delivery row is
      // created and not on retry attempts.
      this.liveEvents?.emitDiscordDelivered(true);
    } catch (sendErr) {
      const safeMessage = sanitiseError((sendErr as Error).message);
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          error: safeMessage,
          failedAttempts: { increment: 1 },
        },
      });

      this.logger.error(
        `Delivery ${delivery.id} failed for event ${eventId}: ${safeMessage}`,
      );
      this.liveEvents?.emitDiscordDelivered(false);
      throw sendErr;
    }
  }
}

/**
 * Belt-and-braces redaction before an error message lands in the DB
 * row or logs. DiscordBotClient already scrubs `Bot <token>` and
 * `/webhooks/{appId}/<interaction-token>`; we repeat the regexes here
 * so a message that reaches this file via another path (future
 * sender, test shim) is still safe.
 */
function sanitiseError(message: string): string {
  return message
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
    .replace(/\/webhooks\/(\d{17,20})\/[^\/\s]+/g, '/webhooks/$1/<redacted>')
    .slice(0, 500);
}

/**
 * Shared PMS blue — same shade existing ProjectReport cards use so
 * the new Sales events read as "part of the same channel visual
 * language" instead of a new palette.
 */
const SALES_PMS_BLUE = 7506394; // 0x7289DA

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function formatInKyiv(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatInTz(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return formatInKyiv(date);
  }
}
