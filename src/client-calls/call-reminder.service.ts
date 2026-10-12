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
// How far into the past the window is allowed to look back. Covers
// one missed 5-min tick (process restart, brief downtime) plus a
// small buffer. Kept short on purpose: the longer this is, the
// easier it is to deliver a reminder that was never meant to fire.
const CATCHUP_WINDOW_MS = 10 * 60 * 1000;
const KYIV_TZ = 'Europe/Kiev';

// Timezone formatting is wrapped: an invalid legacy timezone string
// (e.g. a bare `+2` from an older client build) will make Intl throw
// `RangeError`. We fall back to UTC rather than letting the whole
// per-call processing abort, so one bad row can't swallow a reminder
// or take down the surrounding tick.
function getTimezoneAbbr(date: Date, tz: string): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value ?? tz
    );
  } catch {
    return 'UTC';
  }
}

function formatInTimezone(date: Date, tz: string): string {
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
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }
}

const REMINDER_WINDOWS = [
  {
    offsetMin: 60,
    thresholdMs: 60 * 60 * 1000,
    type: CallReminderType.min60,
    label: '60min' as const,
  },
  {
    offsetMin: 10,
    thresholdMs: 10 * 60 * 1000,
    type: CallReminderType.min10,
    label: '10min' as const,
  },
];


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
    const msUntilBoundary = CRON_INTERVAL_MS - (Date.now() % CRON_INTERVAL_MS);

    setTimeout(() => {
      this.runTick();
      this.interval = setInterval(() => this.runTick(), CRON_INTERVAL_MS);
    }, msUntilBoundary);

    this.logger.log(
      `Call reminder cron aligned to 5-min boundary, first tick in ${Math.round(msUntilBoundary / 1000)}s`,
    );
  }

  private runTick() {
    if (this.running) {
      this.logger.warn('Call reminder tick already running, skipping');
      return;
    }
    this.tick().catch((err: Error) =>
      this.logger.error(`Call reminder tick failed: ${err.message}`),
    );
  }

  onModuleDestroy() {
    clearInterval(this.interval);
  }

  private async tick(): Promise<void> {
    this.running = true;

    try {
      const now = new Date();

      for (const window of REMINDER_WINDOWS) {
        // Catch-up window: [now + offset − CATCHUP, now + offset + TICK].
        // The forward side keeps today's "fire slightly ahead so the
        // embed lands before the actual time" behaviour. The backward
        // side lets us pick up a call whose target moment was in the
        // previous tick's window but didn't get processed because the
        // process restarted. Guards below still prevent fires that
        // should never happen (call already started, call created or
        // rescheduled past its own threshold).
        const windowStart = new Date(
          now.getTime() + window.offsetMin * 60_000 - CATCHUP_WINDOW_MS,
        );
        const windowEnd = new Date(
          now.getTime() + window.offsetMin * 60_000 + CRON_INTERVAL_MS,
        );

        const calls = await this.prisma.clientCall.findMany({
          where: {
            status: ClientCallStatus.scheduled,
            scheduledAt: { gte: windowStart, lte: windowEnd },
          },
          include: {
            lead: {
              select: { firstName: true, lastName: true, companyName: true },
            },
            // crmClient is needed for client-owned calls so the
            // reminder embed doesn't fall back to '—'.
            crmClient: {
              select: { firstName: true, lastName: true, company: true },
            },
            // Legacy — kept for historical rows that still point at
            // a ClientRequest. New calls can't be created against a
            // request, but old ones can still fire their reminders.
            clientRequest: { select: { name: true, company: true } },
          },
        });

        for (const call of calls) {
          // Per-call isolation: one broken call (bad timezone,
          // network blip against the dedup table, downstream throw)
          // must not take out the surrounding tick. The next tick
          // will reconsider the same call.
          try {
            // Hard guard: never fire for a call that already started.
            if (call.scheduledAt.getTime() <= now.getTime()) {
              continue;
            }

            // Hard guard: the reminder for this threshold was never
            // meant to fire if the user had less than `threshold`
            // notice at the moment they created / rescheduled this
            // call. Prevents a 1-hour reminder for a call created
            // 30 minutes before its own time, including when a
            // catch-up window would otherwise cover it.
            const anchorAt = call.rescheduledAt ?? call.createdAt;
            const leadTimeAtAnchorMs =
              call.scheduledAt.getTime() - anchorAt.getTime();
            if (leadTimeAtAnchorMs < window.thresholdMs) {
              continue;
            }

            const clientName =
              call.clientType === 'lead'
                ? `${call.lead?.firstName ?? ''} ${call.lead?.lastName ?? ''}`.trim()
                : call.clientType === 'client'
                  ? `${call.crmClient?.firstName ?? ''} ${call.crmClient?.lastName ?? ''}`.trim()
                  : (call.clientRequest?.name ?? '—');

            await this.sendReminderIdempotent(
              call.id,
              call.callTitle,
              call.scheduledAt,
              call.clientType,
              clientName,
              call.clientTimezone,
              call.duration,
              call.meetingUrl,
              window.type,
              window.label,
            );
          } catch (err) {
            this.logger.error(
              `Call reminder for ${call.id} (${window.label}) failed: ${(err as Error).message}`,
            );
          }
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
    clientType: string,
    clientName: string,
    clientTimezone: string,
    durationMin: number,
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

    // Compensating delete: if `createEvent` fails after we've already
    // written the dedup row, future ticks would otherwise see the
    // reminder as "sent" and never retry. Remove the stamp so the
    // next tick can try again; re-throw so per-call isolation logs it.
    try {
      await this.notifications.createEvent('CALL_REMINDER', {
        callId,
        callTitle,
        reminderType: label,
        clientName,
        clientType,
        clientDateTime: formatInTimezone(scheduledAt, clientTimezone),
        clientTimezone,
        clientTimezoneAbbr: getTimezoneAbbr(scheduledAt, clientTimezone),
        kyivDateTime: formatInTimezone(scheduledAt, KYIV_TZ),
        durationMin,
        meetingUrl,
      });
    } catch (err) {
      await this.prisma.callReminderSent
        .deleteMany({ where: { callId, type } })
        .catch((cleanupErr) =>
          this.logger.error(
            `Failed to roll back dedup stamp for call ${callId} / ${label}: ${(cleanupErr as Error).message}`,
          ),
        );
      throw err;
    }

    this.logger.log(
      `Reminder ${label} queued for call ${callId} — "${callTitle}"`,
    );
  }
}
