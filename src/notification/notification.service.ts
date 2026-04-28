import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationEvent, NotificationType, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SEND,
} from './notification.constants';
import { parseCallReminderPayload } from './schemas/call-reminder.payload';
import { parseJobPostMatchPayload } from './schemas/job-post-match.payload';

const ORPHAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const ORPHAN_AGE_MS = 2 * 60 * 1000; // 2 min

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private connection: IORedis;
  private queue: Queue;
  private orphanInterval: NodeJS.Timeout;
  private orphanRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.connection = new IORedis({
      host: this.config.get('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue(NOTIFICATION_QUEUE, { connection: this.connection });

    this.orphanInterval = setInterval(() => {
      if (this.orphanRunning) {
        this.logger.warn('Orphan recovery already running, skipping tick');
        return;
      }
      this.recoverOrphans().catch((err: Error) =>
        this.logger.error(`Orphan recovery failed: ${err.message}`),
      );
    }, ORPHAN_INTERVAL_MS);

    this.logger.log(
      'Queue initialized, orphan recovery scheduled (interval: 5m, age: 2m)',
    );
  }

  async onModuleDestroy() {
    clearInterval(this.orphanInterval);
    await this.queue.close();
    await this.connection.quit();
  }

  async createEvent(
    type: NotificationType,
    payload: unknown,
  ): Promise<NotificationEvent> {
    const event = await this.prisma.notificationEvent.create({
      data: { type, payload: payload as Prisma.InputJsonValue },
    });

    try {
      await this.dispatch(event);
    } catch (err) {
      this.logger.error(
        `dispatch failed for ${event.id}: ${(err as Error).message}`,
      );
    }

    return event;
  }

  /** Admin utility — re-processes a single event by id. Not called in normal flow. */
  async processEvent(eventId: string): Promise<void> {
    const event = await this.prisma.notificationEvent.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      this.logger.warn(`NotificationEvent ${eventId} not found`);
      return;
    }

    await this.dispatch(event);
  }

  private async dispatch(event: NotificationEvent): Promise<void> {
    this.logger.log(`Processing event ${event.id} [${event.type}]`);

    switch (event.type) {
      case NotificationType.JOB_POST_MATCH:
        await this.handleJobPostMatch(event);
        break;
      case NotificationType.CALL_REMINDER:
        await this.handleCallReminder(event);
        break;
      default:
        this.logger.log(`No rule for event type ${event.type}, skipping`);
    }
  }

  private async handleJobPostMatch(event: NotificationEvent): Promise<void> {
    const payload = parseJobPostMatchPayload(event.payload);

    if (!payload) {
      this.logger.warn(`Invalid payload for event ${event.id}`);
      return;
    }

    if (payload.decision !== 'approve' && payload.decision !== 'maybe') {
      this.logger.log(
        `Event ${event.id} filtered: decision "${payload.decision}" is not approve/maybe`,
      );
      return;
    }

    if (!this.config.get<string>('DISCORD_WEBHOOK_URL')) {
      this.logger.warn(
        `Event ${event.id} skipped: DISCORD_WEBHOOK_URL not configured`,
      );
      return;
    }

    this.logger.log(
      `Event ${event.id} passed rule: decision=${payload.decision}`,
    );

    await this.queue.add(
      NOTIFICATION_SEND,
      { eventId: event.id },
      {
        jobId: event.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Event ${event.id} enqueued for notification`);
  }

  private async handleCallReminder(event: NotificationEvent): Promise<void> {
    const payload = parseCallReminderPayload(event.payload);

    if (!payload) {
      this.logger.warn(`Invalid CALL_REMINDER payload for event ${event.id}`);
      return;
    }

    if (!this.config.get<string>('DISCORD_WEBHOOK_URL')) {
      this.logger.warn(
        `Event ${event.id} skipped: DISCORD_WEBHOOK_URL not configured`,
      );
      return;
    }

    await this.queue.add(
      NOTIFICATION_SEND,
      { eventId: event.id },
      {
        jobId: event.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Call reminder event ${event.id} enqueued`);
  }

  private async recoverOrphans(): Promise<void> {
    this.orphanRunning = true;

    try {
      const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);

      const orphans = await this.prisma.notificationEvent.findMany({
        where: {
          createdAt: { lt: cutoff },
          deliveries: { none: {} },
        },
      });

      if (!orphans.length) return;

      this.logger.log(
        `Found ${orphans.length} orphaned event(s), recovering...`,
      );

      const results = await Promise.allSettled(
        orphans.map((event) => this.dispatch(event)),
      );

      const failed = results.filter((r) => r.status === 'rejected');

      if (failed.length) {
        this.logger.error(
          `${failed.length}/${orphans.length} orphaned events failed to recover`,
        );
      } else {
        this.logger.log(`Recovered ${orphans.length} orphaned event(s)`);
      }
    } finally {
      this.orphanRunning = false;
    }
  }
}
