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
import { DiscordNotificationService } from './discord.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SEND,
  SCORE_THRESHOLDS,
} from './notification.constants';
import { parseJobPostMatchPayload } from './schemas/job-post-match.payload';

const DECISION_COLOR: Record<string, number> = {
  approve: 0x57f287,
  maybe: 0xfee75c,
};

const DECISION_LABEL: Record<string, string> = {
  approve: '✅ approve',
  maybe: '🤔 maybe',
};

const PRIORITY_LABEL: Record<string, string> = {
  high: '🔴 high',
  medium: '🟡 medium',
  low: '🟢 low',
};

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
    private readonly discord: DiscordNotificationService,
  ) {}

  onModuleInit() {
    // const webhookUrl = this.config.get<string>('DISCORD_WEBHOOK_URL');
    //
    // if (!webhookUrl) {
    //   this.logger.warn(
    //     'DISCORD_WEBHOOK_URL is not configured — notification worker disabled',
    //   );
    //   return;
    // }
    //
    // this.connection = new IORedis({
    //   host: this.config.get('REDIS_HOST', 'localhost'),
    //   port: Number(this.config.get('REDIS_PORT', 6379)),
    //   maxRetriesPerRequest: null,
    // });
    //
    // this.worker = new Worker(NOTIFICATION_QUEUE, (job) => this.process(job), {
    //   connection: this.connection,
    //   concurrency: 2,
    // });
    //
    // this.worker.on('failed', (job, err) => {
    //   this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    // });
    //
    // this.logger.log(`Worker for "${NOTIFICATION_QUEUE}" started`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job): Promise<void> {
    if (job.name !== NOTIFICATION_SEND) {
      throw new Error(`Unknown job name: ${job.name}`);
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

    const payload = parseJobPostMatchPayload(event.payload);

    if (!payload) {
      this.logger.warn(`Invalid payload for event ${eventId}, skipping`);
      return;
    }

    const isGreen = payload.score >= SCORE_THRESHOLDS.GREEN;
    const isYellow = payload.score >= SCORE_THRESHOLDS.YELLOW;

    const scoreEmoji = isGreen ? '🟢' : isYellow ? '🟡' : '🔴';
    const scoreChip = `${scoreEmoji} ${payload.score}%`;

    const fields = [
      { name: 'Score', value: scoreChip, inline: true },
      payload.decision
        ? {
            name: 'Decision',
            value: DECISION_LABEL[payload.decision] ?? payload.decision,
            inline: true,
          }
        : null,
      payload.priority
        ? {
            name: 'Priority',
            value: PRIORITY_LABEL[payload.priority] ?? payload.priority,
            inline: true,
          }
        : null,
    ].filter(Boolean);

    const discordBody = {
      embeds: [
        {
          title: `🔥 ${payload.title ?? 'No title'}`,
          url: payload.url ?? undefined,
          color: DECISION_COLOR[payload.decision ?? ''] ?? 0x5865f2,
          description: payload.rawText ?? undefined,
          fields,
        },
      ],
    };

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
      await this.discord.send(discordBody);

      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.SENT,
          sentAt: new Date(),
        },
      });

      this.logger.log(`Delivery ${delivery.id} sent for event ${eventId}`);
    } catch (sendErr) {
      await this.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          error: (sendErr as Error).message,
          failedAttempts: { increment: 1 },
        },
      });

      this.logger.error(
        `Delivery ${delivery.id} failed for event ${eventId}: ${(sendErr as Error).message}`,
      );
      throw sendErr;
    }
  }
}
