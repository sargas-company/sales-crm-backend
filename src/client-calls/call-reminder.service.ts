import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { CallReminderType, ClientCallStatus, Prisma } from '@prisma/client';

import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';

const CRON_INTERVAL_MS = 5 * 60 * 1000;
const KYIV_TZ = 'Europe/Kiev';

const REMINDER_WINDOWS = [
  { offsetMin: 60, type: CallReminderType.min60, label: '60min' as const },
  { offsetMin: 10, type: CallReminderType.min10, label: '10min' as const },
];

function formatKyivTime(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: KYIV_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

@Injectable()
export class CallReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallReminderService.name);
  private interval: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => {
      if (this.running) {
        this.logger.warn('Call reminder tick already running, skipping');
        return;
      }
      this.tick().catch((err: Error) =>
        this.logger.error(`Call reminder tick failed: ${err.message}`),
      );
    }, CRON_INTERVAL_MS);

    this.logger.log('Call reminder cron started (interval: 5m)');
  }

  onModuleDestroy() {
    clearInterval(this.interval);
  }

  private async tick(): Promise<void> {
    this.running = true;

    try {
      const now = new Date();

      for (const window of REMINDER_WINDOWS) {
        const windowStart = new Date(now.getTime() + window.offsetMin * 60_000);
        const windowEnd = new Date(windowStart.getTime() + CRON_INTERVAL_MS);

        const calls = await this.prisma.clientCall.findMany({
          where: {
            status: ClientCallStatus.scheduled,
            scheduledAt: { gte: windowStart, lte: windowEnd },
          },
        });

        for (const call of calls) {
          await this.sendReminderIdempotent(
            call.id,
            call.callTitle,
            call.scheduledAt,
            call.meetingUrl,
            window.type,
            window.label,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async sendReminderIdempotent(
    callId: string,
    callTitle: string,
    scheduledAt: Date,
    meetingUrl: string | null,
    type: CallReminderType,
    label: '60min' | '10min',
  ): Promise<void> {
    try {
      await this.prisma.callReminderSent.create({
        data: { callId, type },
      });
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        this.logger.debug(
          `Reminder ${label} for call ${callId} already sent, skipping`,
        );
        return;
      }
      throw err;
    }

    await this.notifications.createEvent('CALL_REMINDER', {
      callId,
      callTitle,
      scheduledAt: scheduledAt.toISOString(),
      reminderType: label,
      meetingUrl,
      kyivDateTime: formatKyivTime(scheduledAt),
    });

    this.logger.log(
      `Reminder ${label} queued for call ${callId} — "${callTitle}"`,
    );
  }
}
