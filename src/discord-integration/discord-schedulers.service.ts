import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  DiscordDeliveryStatus,
  DiscordJobType,
  type DiscordProfile,
} from '@prisma/client';

/**
 * In-flight lease window: the time a claimed chunk is considered
 * "being sent right now" by another worker. Must be longer than
 * the worst-case Discord HTTP round-trip (bot client timeout +
 * finalise commit) but short enough that a crashed sender does not
 * block a healthy one for too long. 2 minutes covers a 10s HTTP
 * timeout + rate-limit back-off + GC pauses with plenty of slack.
 */
const CHUNK_LEASE_TTL_MS = 2 * 60 * 1000;

type ChunkClaim =
  | { outcome: 'claimed'; deliveryId: string }
  | { outcome: 'already_sent' }
  | { outcome: 'leased'; leaseUntil: Date }
  | { outcome: 'contended' };

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
   * The three phases are strictly separated so NO transaction is
   * ever open across a Discord HTTP call:
   *
   *   1. **claim** — short `$transaction` that takes
   *      `pg_try_advisory_xact_lock(hash31(deliveryKey))`, upserts
   *      the `DiscordDelivery(deliveryKey = JOB:periodKey:chunk:N)`
   *      row, bumps `attempts`, writes an in-flight lease
   *      (`sentAt = now + LEASE_TTL_MS`), and commits. The
   *      transactional advisory lock auto-releases on commit, which
   *      also releases the same-connection guarantee instantly.
   *
   *   2. **send** — no DB transaction, no advisory lock. The chunk
   *      lease on the row is what blocks other instances. On a
   *      successful HTTP response the chunk is finalised; on
   *      failure the row's state is reset so a later tick (after
   *      the lease elapses) can retry it.
   *
   *   3. **finalize** — another short `$transaction` with a plain
   *      UPDATE: SENT + sentAt=now on success, PENDING + sentAt =
   *      Retry-After deadline on 429, PENDING + sentAt=null (lease
   *      released) on other recoverable errors. On a thrown error
   *      we leave the row with the in-flight lease — the next tick
   *      after the lease expires retries from this chunk; earlier
   *      chunks that already flipped SENT are NOT touched.
   *
   * Delivery semantics are **at-least-once**: Discord does not
   * accept a client idempotency key, so a crash between a
   * successful Discord POST and the SENT commit will re-send on
   * the next tick after the lease expires. Everything we control
   * (duplicate delivery rows, double-send inside one tick,
   * cross-instance race) is defended against by the lease + lock +
   * SENT short-circuit.
   *
   * Order of embeds is stable (callers sort before passing them
   * in), so chunk N on retry contains the same slice. `content`
   * attaches to chunk 0 only; later chunks are pure-embed messages.
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

    for (let i = 0; i < chunks.length; i++) {
      const chunkKey = `${baseKey}:chunk:${i}`;
      const claim = await this.claimChunk(args.profile.id, args.jobType, {
        periodKey: args.periodKey,
        chunkKey,
      });
      if (claim.outcome === 'already_sent') continue;
      if (claim.outcome === 'leased') {
        this.logger.debug(
          `chunked ${args.jobType}: chunk ${i} leased until ${claim.leaseUntil.toISOString()}, skipping`,
        );
        return;
      }
      if (claim.outcome === 'contended') {
        this.logger.debug(
          `chunked ${args.jobType}: chunk ${i} contended by another claim, skipping`,
        );
        return;
      }

      // ─── Discord HTTP — explicitly OUTSIDE any Prisma transaction.
      let resp: Awaited<ReturnType<DiscordBotClient['postMessage']>>;
      try {
        resp = await this.bot.postMessage({
          channelId: args.channelId,
          content: i === 0 && args.content ? args.content : undefined,
          embeds: chunks[i].length
            ? (chunks[i] as Record<string, unknown>[])
            : undefined,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        // Ambiguous / thrown transport error — Discord may or may
        // not have accepted the POST. Leave the in-flight lease on
        // the row; after lease expiry a later tick will retry this
        // same chunk slice. Previous SENT chunks are untouched.
        const errMsg = this.scrub(err instanceof Error ? err.message : String(err));
        await this.finaliseAmbiguous(claim.deliveryId, errMsg);
        await this.recordProfileFailure(args.profile.id, errMsg);
        return;
      }

      if (resp.ok) {
        await this.finaliseSuccess(claim.deliveryId);
        await this.recordProfileSuccess(args.profile.id);
        continue;
      }

      const errMsg = this.scrub(`${resp.status}: ${resp.message}`);
      if (resp.retryAfterMs) {
        const leaseUntil = new Date(Date.now() + resp.retryAfterMs);
        await this.finaliseRateLimited(claim.deliveryId, errMsg, leaseUntil);
        await this.recordProfileFailure(args.profile.id, errMsg);
        this.logger.warn(
          `chunked ${args.jobType}: rate-limited, honouring Retry-After ${resp.retryAfterMs}ms (until ${leaseUntil.toISOString()})`,
        );
        return;
      }

      await this.finaliseRecoverableFailure(claim.deliveryId, errMsg);
      await this.recordProfileFailure(args.profile.id, errMsg);
      return;
    }
  }

  // ─── Chunk claim / finalize — SHORT transactions only ───────────

  /**
   * Short-transaction claim for one chunk's `DiscordDelivery` row.
   * Takes a per-chunk `pg_try_advisory_xact_lock` so two parallel
   * callers racing the same `deliveryKey` serialise on that lock;
   * the loser sees the winner's lease on exit and returns
   * `'contended'` (or `'leased'` on the next iteration).
   *
   * The in-flight lease (`sentAt = now + LEASE_TTL_MS`) is persisted
   * so even after the lock is released by tx commit, any other
   * instance that read the row sees "someone else is sending"
   * until the lease expires. Only `status === SENT` is a hard
   * short-circuit.
   */
  private async claimChunk(
    profileId: string,
    jobType: DiscordJobType,
    args: { periodKey: string; chunkKey: string },
  ): Promise<ChunkClaim> {
    const lockKey = this.hash31(args.chunkKey);
    const leaseUntil = new Date(Date.now() + CHUNK_LEASE_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ got: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${lockKey}) AS got
      `;
      if (!row?.got) return { outcome: 'contended' } as const;

      const existing = await tx.discordDelivery.findUnique({
        where: { deliveryKey: args.chunkKey },
      });
      if (existing?.status === DiscordDeliveryStatus.SENT) {
        return { outcome: 'already_sent' } as const;
      }
      if (
        existing?.status === DiscordDeliveryStatus.PENDING &&
        existing.sentAt &&
        existing.sentAt.getTime() > Date.now()
      ) {
        return {
          outcome: 'leased',
          leaseUntil: existing.sentAt,
        } as const;
      }
      const delivery = existing
        ? await tx.discordDelivery.update({
            where: { id: existing.id },
            data: {
              status: DiscordDeliveryStatus.PENDING,
              attempts: existing.attempts + 1,
              sentAt: leaseUntil,
            },
          })
        : await tx.discordDelivery.create({
            data: {
              profileId,
              deliveryKey: args.chunkKey,
              jobType,
              periodKey: args.periodKey,
              status: DiscordDeliveryStatus.PENDING,
              attempts: 1,
              sentAt: leaseUntil,
            },
          });
      return { outcome: 'claimed', deliveryId: delivery.id } as const;
    });
  }

  private finaliseSuccess(deliveryId: string): Promise<unknown> {
    return this.prisma.discordDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DiscordDeliveryStatus.SENT,
        sentAt: new Date(),
        lastError: null,
      },
    });
  }

  private finaliseRateLimited(
    deliveryId: string,
    error: string,
    leaseUntil: Date,
  ): Promise<unknown> {
    return this.prisma.discordDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DiscordDeliveryStatus.PENDING,
        lastError: error,
        sentAt: leaseUntil,
      },
    });
  }

  /**
   * Recoverable (non-429, non-thrown) failure: release the
   * in-flight lease so the next tick can claim and retry. The
   * `attempts` counter was already bumped during claim; this does
   * not advance it further for a single failed response.
   */
  private finaliseRecoverableFailure(
    deliveryId: string,
    error: string,
  ): Promise<unknown> {
    return this.prisma.discordDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DiscordDeliveryStatus.PENDING,
        lastError: error,
        sentAt: null,
      },
    });
  }

  /**
   * Thrown / ambiguous error (axios timeout, DNS, etc. — the
   * Discord POST may or may not have been accepted). We keep the
   * in-flight lease intact so no other tick re-sends inside the
   * lease window. After the lease expires, a later tick will claim
   * and retry.
   */
  private finaliseAmbiguous(deliveryId: string, error: string): Promise<unknown> {
    return this.prisma.discordDelivery.update({
      where: { id: deliveryId },
      data: { lastError: error },
    });
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

  private async recordProfileSuccess(profileId: string): Promise<void> {
    await this.prisma.discordProfile.update({
      where: { id: profileId },
      data: { lastSuccessAt: new Date() },
    });
  }

  private async recordProfileFailure(
    profileId: string,
    message: string,
  ): Promise<void> {
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
