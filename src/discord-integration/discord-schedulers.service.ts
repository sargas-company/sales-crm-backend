import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
  type DiscordProfile,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import { DiscordLateReportService } from './discord-late-report.service';
import { logicalReportDate, localCalendarDate } from './logical-date';

/**
 * Scheduled Discord notifications.
 *
 * **Catch-up semantics**: a job fires once per `(jobType, periodKey)`,
 * at the first scheduler tick that satisfies
 *     `local-now >= scheduled T` AND no SENT delivery exists.
 * This means a job scheduled for 09:00 that the app slept through
 * will still fire the moment the app comes back (even at 09:47).
 * Idempotency is anchored on `DiscordDelivery.deliveryKey`, which
 * doubles as the dedup token for the whole period.
 *
 * The reminder job has a special shortcut: if `local-now` is already
 * at or past `dailyDigestAt`, the reminder is skipped — a 20-minute-
 * late reminder is useful; a reminder sent after the digest it was
 * supposed to prompt is not.
 */
@Injectable()
export class DiscordSchedulersService {
  private readonly logger = new Logger(DiscordSchedulersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: DiscordBotClient,
    private readonly embeds: DiscordEmbedBuilderService,
    private readonly lateReports: DiscordLateReportService,
  ) {}

  @Cron('0 * * * * *', { name: 'discord-tick' })
  async tick(): Promise<void> {
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
    });
    if (!profile) return;
    const nowHM = this.currentHM(profile.timezone);
    const todayKey = localCalendarDate(new Date(), profile.timezone)
      .toISOString()
      .slice(0, 10);

    if (profile.birthdaysEnabled && this.timeReached(nowHM, profile.birthdayAt)) {
      await this.runOnce(profile, DiscordJobType.BIRTHDAY, todayKey, () =>
        this.runBirthday(profile),
      );
    }
    if (profile.absencesEnabled && this.timeReached(nowHM, profile.absencesAt)) {
      await this.runOnce(profile, DiscordJobType.ABSENCES, todayKey, () =>
        this.runAbsences(profile),
      );
    }
    if (profile.reportsEnabled && this.timeReached(nowHM, profile.reminderAt)) {
      // Reminder is only useful BEFORE the digest; after that it's noise.
      if (!this.timeReached(nowHM, profile.dailyDigestAt)) {
        await this.runOnce(profile, DiscordJobType.REMINDER_18, todayKey, () =>
          this.runReminder(profile),
        );
      }
    }
    if (profile.reportsEnabled && this.timeReached(nowHM, profile.dailyDigestAt)) {
      await this.runOnce(profile, DiscordJobType.DAILY_DIGEST_19, todayKey, () =>
        this.runDailyDigest(profile),
      );
    }
    if (profile.weeklyEnabled) {
      const dow = this.currentDow(profile.timezone);
      if (dow === profile.weeklyDigestDay && this.timeReached(nowHM, profile.weeklyDigestAt)) {
        await this.runOnce(profile, DiscordJobType.WEEKLY_DIGEST, todayKey, () =>
          this.runWeeklyDigest(profile),
        );
      }
    }

    // Durable retry for late-report deliveries (independent of HH:MM).
    await this.lateReports.tick();
  }

  // ─── Once-per-period runner ─────────────────────────────────────

  private async runOnce(
    profile: DiscordProfile,
    jobType: DiscordJobType,
    periodKey: string,
    body: () => Promise<void>,
  ): Promise<void> {
    const dedupKey = `${jobType}:${profile.id}:${periodKey}`;
    const lockKey = this.hash31(dedupKey);
    const [row] = await this.prisma.$queryRaw<Array<{ got: boolean }>>`
      SELECT pg_try_advisory_lock(${lockKey}) AS got
    `;
    if (!row?.got) return;
    try {
      const existing = await this.prisma.discordDelivery.findUnique({
        where: { deliveryKey: dedupKey },
      });
      if (existing && existing.status === DiscordDeliveryStatus.SENT) return;
      if (existing) {
        await this.prisma.discordDelivery.update({
          where: { id: existing.id },
          data: {
            status: DiscordDeliveryStatus.PENDING,
            attempts: existing.attempts + 1,
          },
        });
      } else {
        await this.prisma.discordDelivery.create({
          data: {
            profileId: profile.id,
            deliveryKey: dedupKey,
            jobType,
            periodKey,
            status: DiscordDeliveryStatus.PENDING,
            attempts: 1,
          },
        });
      }

      try {
        await body();
        await this.prisma.discordDelivery.update({
          where: { deliveryKey: dedupKey },
          data: {
            status: DiscordDeliveryStatus.SENT,
            sentAt: new Date(),
            lastError: null,
          },
        });
        await this.recordProfileSuccess(profile.id);
      } catch (err) {
        const msg = this.scrub(err instanceof Error ? err.message : String(err));
        await this.prisma.discordDelivery.update({
          where: { deliveryKey: dedupKey },
          data: {
            // Keep PENDING unless we have exhausted attempts, so the
            // next tick retries. Backoff is implicit via the one-
            // minute scheduler cadence.
            status: DiscordDeliveryStatus.PENDING,
            lastError: msg,
          },
        });
        await this.recordProfileFailure(profile.id, msg);
        if (profile.opsChannelId && jobType !== DiscordJobType.LATE_REPORT) {
          try {
            await this.bot.postMessage({
              channelId: profile.opsChannelId,
              content: `⚠️ Discord job \`${jobType}\` failed on profile \`${profile.name}\`:\n\`\`\`\n${msg}\n\`\`\``,
            });
          } catch {
            /* don't recurse */
          }
        }
      }
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  // ─── Individual job bodies — throw on failure ────────────────────

  private async runBirthday(profile: DiscordProfile): Promise<void> {
    if (!profile.generalChannelId) throw new Error('generalChannelId missing');
    const today = localCalendarDate(new Date(), profile.timezone);
    const month = today.getUTCMonth() + 1;
    const day = today.getUTCDate();
    const employees = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT ("firstName" || ' ' || "lastName") AS "name"
        FROM "Employee"
       WHERE status = 'active'
         AND "dateOfBirth" IS NOT NULL
         AND EXTRACT(MONTH FROM "dateOfBirth") = ${month}
         AND EXTRACT(DAY FROM "dateOfBirth") = ${day}
    `;
    if (!employees.length) return;
    const resp = await this.bot.postMessage({
      channelId: profile.generalChannelId,
      content: this.embeds.birthdayContent(employees.map((e) => e.name)),
      allowedMentions: { parse: ['everyone'] },
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  private async runAbsences(profile: DiscordProfile): Promise<void> {
    const dow = this.currentDow(profile.timezone);
    if (dow === 0 || dow === 6) return;
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const today = localCalendarDate(new Date(), profile.timezone);
    const offs = await this.prisma.timeOff.findMany({
      where: {
        startDate: { lte: today },
        endDate: { gte: today },
        employee: { status: 'active' },
      },
      include: { employee: { select: { firstName: true, lastName: true } } },
    });
    const embeds = offs.length
      ? this.embeds.absencesEmbeds(
          offs.map((o) => ({
            type: o.type,
            firstName: o.employee.firstName,
            lastName: o.employee.lastName,
            endDate: o.endDate,
          })),
        )
      : undefined;
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content: offs.length ? 'Who is off today' : 'Everyone is working today.',
      embeds,
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  private async runReminder(profile: DiscordProfile): Promise<void> {
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const isWeekend = [0, 6].includes(this.currentDow(profile.timezone));
    let shouldPing = !isWeekend;
    if (isWeekend) {
      const projects = await this.prisma.project.findMany({
        where: { status: { in: ['active', 'planned'] } },
        select: { id: true },
      });
      const range = this.weekRange(profile.timezone);
      for (const p of projects) {
        const sum = await this.prisma.projectReport.aggregate({
          where: {
            projectId: p.id,
            reportDate: { gte: range.gte, lte: range.lte },
          },
          _sum: { hours: true },
        });
        if ((sum._sum.hours ?? 0) < 40) {
          shouldPing = true;
          break;
        }
      }
    }
    if (!shouldPing) return;
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content: this.embeds.reminderContent(profile.managerRoleId),
      allowedMentions: profile.managerRoleId ? { parse: ['roles'] } : undefined,
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  private async runDailyDigest(profile: DiscordProfile): Promise<void> {
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const logical = logicalReportDate({
      now: new Date(),
      cutoffHour: profile.cutoffHour,
      timezone: profile.timezone,
    });
    const reports = await this.prisma.projectReport.findMany({
      where: { reportDate: logical },
      include: {
        project: { select: { name: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
    });
    if (!reports.length) return;
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content: `Daily reports — ${logical.toISOString().slice(0, 10)}`,
      embeds: this.embeds.dailyDigestEmbeds({
        reportDate: logical,
        rows: reports.map((r) => ({
          projectName: r.project.name,
          authorName: r.employee
            ? `${r.employee.firstName} ${r.employee.lastName}`
            : (r.discordUsername ?? 'Discord user'),
          hours: r.hours,
        })),
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  private async runWeeklyDigest(profile: DiscordProfile): Promise<void> {
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const prev = this.previousWeekRange(profile.timezone);
    const totals = await this.prisma.$queryRaw<Array<{ name: string; hours: number }>>`
      SELECT p.name, SUM(r.hours)::float AS hours
        FROM "ProjectReport" r
        JOIN "Project" p ON p.id = r."projectId"
       WHERE r."reportDate" >= ${prev.start}::date
         AND r."reportDate" <= ${prev.end}::date
       GROUP BY p.id, p.name
       ORDER BY p.name
    `;
    if (!totals.length) return;
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content: `Weekly reports — ${prev.start.toISOString().slice(0, 10)}…${prev.end
        .toISOString()
        .slice(0, 10)}`,
      embeds: this.embeds.weeklyDigestEmbeds(
        totals.map((t) => ({ projectName: t.name, hours: Number(t.hours) })),
      ),
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  // ─── Housekeeping ──────────────────────────────────────────────

  private async recordProfileSuccess(profileId: string): Promise<void> {
    await this.prisma.discordProfile.update({
      where: { id: profileId },
      data: { lastSuccessAt: new Date() },
    });
  }

  private async recordProfileFailure(profileId: string, message: string): Promise<void> {
    await this.prisma.discordProfile.update({
      where: { id: profileId },
      data: {
        lastFailureAt: new Date(),
        lastFailureMessage: message.slice(0, 500),
      },
    });
  }

  private async releaseLock(key: number): Promise<void> {
    try {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${key})`;
    } catch {
      /* non-fatal */
    }
  }

  // ─── Time helpers ──────────────────────────────────────────────

  private timeReached(nowHM: string, scheduledHM: string): boolean {
    // "HH:MM" lexicographic compare == chronological compare for a
    // 24h zero-padded time, so this is strictly equivalent to minute
    // comparison without the integer parse round-trip.
    return nowHM >= scheduledHM;
  }

  currentHM(timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h === '24' ? '00' : h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }

  currentDow(timezone: string): number {
    const w =
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'weekday')?.value ?? 'Mon';
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] ?? 1;
  }

  private weekRange(timezone: string): { gte: Date; lte: Date } {
    const today = localCalendarDate(new Date(), timezone);
    const dow = this.currentDow(timezone);
    const diff = (dow + 6) % 7;
    const start = new Date(today);
    start.setUTCDate(today.getUTCDate() - diff);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { gte: start, lte: end };
  }

  private previousWeekRange(timezone: string): { start: Date; end: Date } {
    const cur = this.weekRange(timezone);
    const start = new Date(cur.gte);
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(cur.lte);
    end.setUTCDate(end.getUTCDate() - 7);
    return { start, end };
  }

  private hash31(seed: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h & 0x7fffffff;
  }

  private scrub(s: string): string {
    return s.replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>').slice(0, 500);
  }
}
