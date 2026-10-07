import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
  Prisma,
  type DiscordProfile,
} from '@prisma/client';

/**
 * Prisma client-or-tx shape — accepts both the top-level
 * `PrismaService` and the `tx` argument of `$transaction(async(tx)
 * => ...)`. Used for helpers that must run on the same pinned
 * connection as a surrounding transaction (lock scope).
 */
type TxLike = Pick<Prisma.TransactionClient, 'discordProfile'> | import('../prisma/prisma.service').PrismaService;

import { PrismaService } from '../prisma/prisma.service';
import { chunkEmbeds, type DiscordEmbed } from './discord-chunking';
import { DiscordBotClient } from './discord-bot.client';
import { DiscordEmbedBuilderService } from './discord-embed-builder.service';
import { DiscordLateReportService } from './discord-late-report.service';
import { logicalReportDate, localCalendarDate, parseHHMM } from './logical-date';

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
    private readonly config: ConfigService,
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
      // Absences uses chunked per-chunk delivery (ABSENCES:<date>:chunk:N)
      // so the "Everyone is working today." branch is also idempotent
      // and a failed non-empty chunk 1 does not re-send chunk 0.
      try {
        await this.runAbsences(profile);
      } catch (err) {
        await this.handleChunkedError(profile, DiscordJobType.ABSENCES, err);
      }
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
      // Chunked jobs own their per-chunk DiscordDelivery rows + their
      // own advisory lock; the single-row `runOnce` dedup gate is not
      // used here.
      try {
        await this.runDailyDigest(profile);
      } catch (err) {
        await this.handleChunkedError(
          profile,
          DiscordJobType.DAILY_DIGEST_19,
          err,
        );
      }
    }
    if (profile.weeklyEnabled) {
      const dow = this.currentDow(profile.timezone);
      if (dow === profile.weeklyDigestDay && this.timeReached(nowHM, profile.weeklyDigestAt)) {
        try {
          await this.runWeeklyDigest(profile);
        } catch (err) {
          await this.handleChunkedError(
            profile,
            DiscordJobType.WEEKLY_DIGEST,
            err,
          );
        }
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
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
      // Stable ordering so chunk slices are deterministic across
      // retries — the per-chunk delivery key keys the same slice
      // regardless of which tick creates it.
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    const periodKey = today.toISOString().slice(0, 10);
    const embeds = offs.length
      ? this.embeds.absencesEmbeds(
          offs.map((o) => ({
            type: o.type,
            firstName: o.employee.firstName,
            lastName: o.employee.lastName,
            endDate: o.endDate,
          })),
        )
      : [];
    // Both paths route through sendChunked so that:
    //   - the empty "Everyone is working today." case still gets a
    //     `ABSENCES:<date>:chunk:0` row and will not re-fire on a
    //     catch-up tick;
    //   - the non-empty case gets per-chunk delivery keys and never
    //     re-sends chunk 0 after a chunk 1 failure.
    await this.sendChunked({
      profile,
      jobType: DiscordJobType.ABSENCES,
      periodKey,
      channelId: profile.pmsChannelId,
      content: offs.length ? 'Who is off today' : 'Everyone is working today.',
      embeds,
    });
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
    const reportsUrl = this.reportsUrl();
    const content = this.embeds.reminderContent(
      profile.managerRoleId,
      reportsUrl,
    );
    // Strict mention policy: pass the single managerRoleId through
    // allowedMentions.roles. parse:[] blocks @everyone, @here, any
    // user mention and any other role id that might sneak into the
    // body (none here, but defensive).
    const resp = await this.bot.postMessage({
      channelId: profile.pmsChannelId,
      content,
      allowedMentions: profile.managerRoleId
        ? { parse: [], roles: [profile.managerRoleId] }
        : { parse: [] },
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${resp.message}`);
  }

  private async runDailyDigest(profile: DiscordProfile): Promise<void> {
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const now = new Date();
    const logical = logicalReportDate({
      now,
      cutoffHour: profile.cutoffHour,
      timezone: profile.timezone,
    });
    // Catch-up safety: when the scheduler runs after a long downtime
    // we must not scoop up reports that have already been flipped to
    // the late-report path. The deadline is `dailyDigestAt` on the
    // logical calendar day in the profile's timezone — any
    // `createdAt >= deadline` row is owned by the late-report queue.
    const deadlineUtc = this.deadlineForLogicalDate(
      logical,
      profile.dailyDigestAt,
      profile.timezone,
    );
    const reports = await this.prisma.projectReport.findMany({
      where: {
        reportDate: logical,
        createdAt: { lt: deadlineUtc },
      },
      include: {
        project: { select: { name: true } },
        employee: { select: { firstName: true, lastName: true } },
      },
      // Stable order so chunk slices are deterministic across retries.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!reports.length) return;
    const embeds = this.embeds.dailyDigestEmbeds({
      reportDate: logical,
      rows: reports.map((r) => ({
        projectName: r.project.name,
        authorName: r.employee
          ? `${r.employee.firstName} ${r.employee.lastName}`
          : (r.discordUsername ?? 'Discord user'),
        hours: r.hours,
      })),
    });
    const periodKey = logical.toISOString().slice(0, 10);
    await this.sendChunked({
      profile,
      jobType: DiscordJobType.DAILY_DIGEST_19,
      periodKey,
      channelId: profile.pmsChannelId,
      content: `Daily reports — ${periodKey}`,
      embeds,
    });
  }

  private async runWeeklyDigest(profile: DiscordProfile): Promise<void> {
    if (!profile.pmsChannelId) throw new Error('pmsChannelId missing');
    const prev = this.previousWeekRange(profile.timezone);
    // LEFT JOIN semantics: every active/planned project appears,
    // even when it has no reports for the previous week (0.00 hours
    // + red). Stable `ORDER BY name, id` tie-break matches the
    // chunk-idempotency contract.
    const totals = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; hours: number }>
    >`
      SELECT p.id,
             p.name,
             COALESCE(SUM(r.hours), 0)::float AS hours
        FROM "Project" p
        LEFT JOIN "ProjectReport" r
          ON r."projectId" = p.id
         AND r."reportDate" >= ${prev.start}::date
         AND r."reportDate" <= ${prev.end}::date
       WHERE p.status IN ('active', 'planned')
       GROUP BY p.id, p.name
       ORDER BY p.name ASC, p.id ASC
    `;
    if (!totals.length) return;
    const embeds = this.embeds.weeklyDigestEmbeds(
      totals.map((t) => ({ projectName: t.name, hours: Number(t.hours) })),
    );
    await this.sendChunked({
      profile,
      jobType: DiscordJobType.WEEKLY_DIGEST,
      periodKey: `${prev.start.toISOString().slice(0, 10)}..${prev.end
        .toISOString()
        .slice(0, 10)}`,
      channelId: profile.pmsChannelId,
      content: `Weekly reports — ${prev.start.toISOString().slice(0, 10)}…${prev.end
        .toISOString()
        .slice(0, 10)}`,
      embeds,
    });
  }

  /**
   * Chunked, per-chunk-idempotent send.
   *
   * Each chunk gets its own `DiscordDelivery(deliveryKey =
   * JOB:periodKey:chunk:N)`. On entry we:
   *   1. slice `embeds` into Discord-safe chunks via `chunkEmbeds`
   *      (empty + non-empty content both produce ≥1 chunk);
   *   2. walk them in order inside ONE Prisma `$transaction` so the
   *      acquire + per-chunk UPDATEs + unlock all run on the same
   *      PostgreSQL connection — session-scope advisory lock would
   *      otherwise leak across pool connections. We use
   *      `pg_try_advisory_xact_lock` so the lock auto-releases on
   *      transaction end, success or failure, with no manual unlock
   *      step to forget;
   *   3. for each chunk — SKIP if SENT, SKIP if PENDING with
   *      `sentAt` in the future (429 backoff lease), SEND otherwise.
   *      On success flip to SENT; on failure leave PENDING with
   *      `sentAt = now + retryAfterMs` so the next tick that fires
   *      before the Retry-After window elapses will skip and bail.
   *
   * The order of embeds is stable (callers sort before passing them
   * in), so chunk N on retry contains the same slice as before. The
   * `content` text is attached to chunk 0 only; later chunks are
   * pure-embed messages so Discord doesn't repeat the header.
   *
   * Transaction timeout is lifted to 60s because the chunk loop
   * includes Discord HTTP calls (axios ≤10s per POST, up to ~24
   * chunks of 10 embeds would be the realistic ceiling). This holds
   * one Prisma connection for the duration of the send — the trade-
   * off is intentional: correctness of cross-instance mutual
   * exclusion requires same-connection acquire+release, and the
   * daily/weekly cadence makes a once-a-day held connection cheap.
   */
  private async sendChunked(args: {
    profile: DiscordProfile;
    jobType: DiscordJobType;
    periodKey: string;
    channelId: string;
    content: string;
    embeds: readonly DiscordEmbed[];
  }): Promise<void> {
    const chunksRaw = chunkEmbeds(args.embeds);
    // Content-only path (absences "Everyone is working today."):
    // zero embeds + non-empty content → one empty-embed-list chunk.
    const chunks: DiscordEmbed[][] =
      chunksRaw.length > 0
        ? chunksRaw
        : args.content
          ? [[]]
          : [];
    if (!chunks.length) return;
    const baseKey = `${args.jobType}:${args.periodKey}`;
    const lockKey = this.hash31(`chunked:${baseKey}`);

    await this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ got: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${lockKey}) AS got
        `;
        if (!row?.got) return;

        for (let i = 0; i < chunks.length; i++) {
          const chunkKey = `${baseKey}:chunk:${i}`;
          const existing = await tx.discordDelivery.findUnique({
            where: { deliveryKey: chunkKey },
          });
          if (existing?.status === DiscordDeliveryStatus.SENT) continue;

          // Rate-limit lease on `sentAt`: when a 429 landed, we set
          // sentAt to the next permissible attempt time. PENDING +
          // sentAt in the future ⇒ do not try yet and do not touch
          // later chunks (they can't jump ahead).
          if (
            existing?.status === DiscordDeliveryStatus.PENDING &&
            existing.sentAt &&
            existing.sentAt.getTime() > Date.now()
          ) {
            this.logger.debug(
              `chunked ${args.jobType}: chunk ${i} backoff until ${existing.sentAt.toISOString()}`,
            );
            return;
          }

          const delivery = existing
            ? await tx.discordDelivery.update({
                where: { id: existing.id },
                data: {
                  status: DiscordDeliveryStatus.PENDING,
                  attempts: existing.attempts + 1,
                  // Clear the lease marker; we are retrying now.
                  sentAt: null,
                },
              })
            : await tx.discordDelivery.create({
                data: {
                  profileId: args.profile.id,
                  deliveryKey: chunkKey,
                  jobType: args.jobType,
                  periodKey: args.periodKey,
                  status: DiscordDeliveryStatus.PENDING,
                  attempts: 1,
                },
              });

          const resp = await this.bot.postMessage({
            channelId: args.channelId,
            content: i === 0 && args.content ? args.content : undefined,
            embeds: chunks[i].length
              ? (chunks[i] as Record<string, unknown>[])
              : undefined,
            allowedMentions: { parse: [] },
          });
          if (resp.ok) {
            await tx.discordDelivery.update({
              where: { id: delivery.id },
              data: {
                status: DiscordDeliveryStatus.SENT,
                sentAt: new Date(),
                lastError: null,
              },
            });
            await this.recordProfileSuccess(args.profile.id, tx);
            continue;
          }
          const errMsg = this.scrub(`${resp.status}: ${resp.message}`);
          // 429 backoff: lease sentAt forward by retryAfterMs so
          // ticks inside the window skip this chunk entirely.
          const leaseUntil = resp.retryAfterMs
            ? new Date(Date.now() + resp.retryAfterMs)
            : null;
          await tx.discordDelivery.update({
            where: { id: delivery.id },
            data: {
              status: DiscordDeliveryStatus.PENDING,
              lastError: errMsg,
              sentAt: leaseUntil,
            },
          });
          await this.recordProfileFailure(args.profile.id, errMsg, tx);
          if (leaseUntil) {
            this.logger.warn(
              `chunked ${args.jobType}: rate-limited, honouring Retry-After ${resp.retryAfterMs}ms (until ${leaseUntil.toISOString()})`,
            );
          }
          return;
        }
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Non-fatal error handler for chunked jobs. The chunk-send loop
   * records per-chunk failure state on `DiscordDelivery` itself, so
   * this is only reached when something outside the send loop blew
   * up (DB query, embed builder). Record it on the profile and
   * surface via the Ops channel like `runOnce` does.
   */
  private async handleChunkedError(
    profile: DiscordProfile,
    jobType: DiscordJobType,
    err: unknown,
  ): Promise<void> {
    const msg = this.scrub(err instanceof Error ? err.message : String(err));
    await this.recordProfileFailure(profile.id, msg);
    if (profile.opsChannelId) {
      try {
        await this.bot.postMessage({
          channelId: profile.opsChannelId,
          content: `⚠️ Discord job \`${jobType}\` failed on profile \`${profile.name}\`:\n\`\`\`\n${msg}\n\`\`\``,
          allowedMentions: { parse: [] },
        });
      } catch {
        /* don't recurse */
      }
    }
  }

  /**
   * `${FRONTEND_URL}/projects/reports` with trailing-slash
   * normalisation. The env var name matches the operational
   * contract on production. Empty string when `FRONTEND_URL` is
   * not configured — callers surface this as "no link" rather
   * than crashing.
   */
  private reportsUrl(): string {
    const raw = this.config.get<string>('FRONTEND_URL') ?? '';
    if (!raw) return '';
    return `${raw.replace(/\/+$/, '')}/projects/reports`;
  }

  /**
   * UTC `Date` for the `HH:MM` deadline on the given logical calendar
   * day in `timezone`. Rendered against the local calendar day so the
   * daily-digest filter and the late-report predicate agree down to
   * the minute, even across DST transitions.
   */
  private deadlineForLogicalDate(
    logicalMidnightUtc: Date,
    hhmm: string,
    timezone: string,
  ): Date {
    const minutes = parseHHMM(hhmm);
    // Walk minute by minute from local-noon of the logical day until
    // the local wall clock matches the deadline minute. Local noon is
    // on the correct calendar day under every IANA zone (DST shifts
    // never exceed 2h); binary-searching the UTC range avoids any
    // offset-math landmines.
    const anchor = new Date(logicalMidnightUtc.getTime() + 12 * 60 * 60 * 1000);
    const target = minutes;
    const anchorMinutes = this.localMinuteOfDay(anchor, timezone);
    const deltaMinutes = target - anchorMinutes;
    return new Date(anchor.getTime() + deltaMinutes * 60 * 1000);
  }

  private localMinuteOfDay(d: Date, timezone: string): number {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = fmt.formatToParts(d);
    const h = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return (h === 24 ? 0 : h) * 60 + m;
  }

  // ─── Housekeeping ──────────────────────────────────────────────

  private async recordProfileSuccess(
    profileId: string,
    client: TxLike = this.prisma,
  ): Promise<void> {
    await client.discordProfile.update({
      where: { id: profileId },
      data: { lastSuccessAt: new Date() },
    });
  }

  private async recordProfileFailure(
    profileId: string,
    message: string,
    client: TxLike = this.prisma,
  ): Promise<void> {
    await client.discordProfile.update({
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
