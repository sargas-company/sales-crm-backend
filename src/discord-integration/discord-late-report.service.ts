import { Injectable, Logger } from '@nestjs/common';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import type { DiscordReportResult } from './discord-report.service';

/**
 * Late-report notifier.
 *
 * Owns two phases:
 *   1. `enqueue(result)` — called right after a `/report` row commits.
 *      Creates a PENDING DiscordDelivery(deliveryKey=LATE_REPORT:<reportId>).
 *      One row per report; `deliveryKey` UNIQUE catches a duplicate
 *      from a crash-restart.
 *   2. `tick()` — called on every scheduler minute; picks all PENDING
 *      rows for the active profile, attempts the send, flips to SENT
 *      or stays PENDING for the next tick (bounded by `attempts`).
 *
 * The record of what to send is baked into the delivery row's
 * `periodKey` so the retry does not need to re-read the ProjectReport
 * row — the message is a stable snapshot of the moment the report
 * was filed.
 */
@Injectable()
export class DiscordLateReportService {
  private readonly logger = new Logger(DiscordLateReportService.name);
  private readonly MAX_ATTEMPTS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
    private readonly embeds: DiscordEmbedBuilderService,
  ) {}

  async enqueue(result: DiscordReportResult): Promise<void> {
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { id: true },
    });
    if (!profile) return;
    const dedupKey = `LATE_REPORT:${result.reportId}`;
    const snapshot = JSON.stringify({
      projectName: result.projectName,
      hours: result.hours,
      reportDate: result.reportDate.toISOString(),
      text: result.text,
      submittedAt: result.submittedAt.toISOString(),
    });
    try {
      await this.prisma.discordDelivery.create({
        data: {
          profileId: profile.id,
          deliveryKey: dedupKey,
          jobType: DiscordJobType.LATE_REPORT,
          periodKey: snapshot,
          status: DiscordDeliveryStatus.PENDING,
          attempts: 0,
        },
      });
    } catch (err) {
      // P2002 → already enqueued (crash-restart or duplicate call).
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }

  async tick(): Promise<void> {
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { id: true, pmsChannelId: true, reportsEnabled: true },
    });
    if (!profile || !profile.reportsEnabled || !profile.pmsChannelId) return;
    const pending = await this.prisma.discordDelivery.findMany({
      where: {
        profileId: profile.id,
        jobType: DiscordJobType.LATE_REPORT,
        status: DiscordDeliveryStatus.PENDING,
        attempts: { lt: this.MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const row of pending) {
      let payload: ReturnType<typeof this.decodeSnapshot>;
      try {
        payload = this.decodeSnapshot(row.periodKey);
      } catch {
        await this.markFailed(row.id, 'corrupt periodKey');
        continue;
      }
      // Late PMS card uses the SAME compact shape as a Daily Digest
      // row: project name + hours only, color by `> 6`. Snapshot may
      // still carry text/submittedAt from pre-change rows — we read
      // just the two fields we need and ignore the rest.
      const embed = this.embeds.compactReportCard({
        projectName: payload.projectName,
        hours: payload.hours,
      });
      const resp = await this.bot.postMessage({
        channelId: profile.pmsChannelId!,
        embeds: [embed as Record<string, unknown>],
        allowedMentions: { parse: [] },
      });
      if (resp.ok) {
        await this.prisma.discordDelivery.update({
          where: { id: row.id },
          data: {
            status: DiscordDeliveryStatus.SENT,
            sentAt: new Date(),
            attempts: row.attempts + 1,
            lastError: null,
          },
        });
      } else {
        await this.prisma.discordDelivery.update({
          where: { id: row.id },
          data: {
            // Keep PENDING unless we have exhausted attempts, so the
            // next tick retries. Backoff is implicit via the one-
            // minute scheduler cadence; 429s set `retryAfterMs` which
            // we honour by skipping remaining rows this tick.
            status:
              row.attempts + 1 >= this.MAX_ATTEMPTS
                ? DiscordDeliveryStatus.FAILED
                : DiscordDeliveryStatus.PENDING,
            attempts: row.attempts + 1,
            lastError: resp.message.slice(0, 500),
          },
        });
        if (resp.retryAfterMs) {
          this.logger.warn(
            `late-report rate-limited; honouring Retry-After ${resp.retryAfterMs}ms`,
          );
          break;
        }
      }
    }
  }

  private decodeSnapshot(raw: string) {
    const o = JSON.parse(raw) as {
      projectName: string;
      hours: number;
      reportDate: string;
      text: string;
      submittedAt: string;
    };
    return {
      projectName: o.projectName,
      hours: o.hours,
      reportDate: new Date(o.reportDate),
      text: o.text,
      submittedAt: new Date(o.submittedAt),
    };
  }

  private async markFailed(id: string, message: string): Promise<void> {
    await this.prisma.discordDelivery.update({
      where: { id },
      data: {
        status: DiscordDeliveryStatus.FAILED,
        lastError: message.slice(0, 500),
      },
    });
  }
}
