import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DiscordDeliveryStatus,
  Prisma,
  ProjectReportSource,
} from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { DiscordLateReportService } from '../discord-integration/discord-late-report.service';
import {
  isLateReport,
  localCalendarDate,
  parseHHMM,
} from '../discord-integration/logical-date';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectReportDto } from './dto/create-project-report.dto';
import {
  ListProjectReportsDto,
  ProjectReportSortBy,
  ProjectReportSortDirection,
} from './dto/list-project-reports.dto';
import { UpdateProjectReportDto } from './dto/update-project-report.dto';
import { projectReportLockKey } from './project-report.lock';

/**
 * ProjectReport is now a **project-day** record: one row per
 * `(projectId, reportDate)` regardless of source. The business
 * record of "who was on the team at the moment of submission" is
 * the immutable `ProjectReportContributor` snapshot, copied from
 * the current `ProjectMember` set under the same advisory lock.
 *
 * `source`, `discordUserId`, `discordUsername` are retained as
 * technical submitter metadata only — they are not surfaced as
 * author anywhere in the API or UI.
 */
@Injectable()
export class ProjectReportService {
  private readonly logger = new Logger(ProjectReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lateReports: DiscordLateReportService,
  ) {}

  async create(dto: CreateProjectReportDto, user: AuthUser) {
    await this.assertProjectExists(dto.projectId);
    await this.assertCanWriteProject(user, dto.projectId);

    const reportDate = this.dayOnly(dto.reportDate);
    const lockKey = projectReportLockKey(dto.projectId, reportDate);

    let created: Prisma.ProjectReportGetPayload<{
      include: ReturnType<ProjectReportService['include']>;
    }>;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

        const existing = await tx.projectReport.findUnique({
          where: {
            projectId_reportDate: { projectId: dto.projectId, reportDate },
          },
          select: { id: true },
        });
        if (existing) {
          throw new ConflictException(
            'A report for this project already exists for the given date.',
          );
        }

        const members = await tx.projectMember.findMany({
          where: { projectId: dto.projectId },
          include: {
            employee: { select: { id: true, firstName: true, lastName: true } },
          },
        });
        if (members.length === 0) {
          throw new UnprocessableEntityException(
            'This project has no team members. Add at least one employee to the project before filing a report.',
          );
        }

        return tx.projectReport.create({
          data: {
            projectId: dto.projectId,
            reportDate,
            hours: dto.hours,
            content: dto.content,
            source: ProjectReportSource.MANUAL,
            contributors: {
              create: members.map((m) => ({
                employeeId: m.employee.id,
                firstNameSnapshot: m.employee.firstName,
                lastNameSnapshot: m.employee.lastName,
              })),
            },
          },
          include: this.include(),
        });
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }

    await this.enqueueLateDeliveryIfNeeded(created);
    return created;
  }

  async findAll(dto: ListProjectReportsDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? ProjectReportSortDirection.desc;

    const scopeWhere = await this.buildScopeWhere(user);

    const where: Prisma.ProjectReportWhereInput = {
      AND: [
        scopeWhere,
        dto.projectId ? { projectId: dto.projectId } : {},
        dto.from || dto.to
          ? {
              reportDate: {
                ...(dto.from ? { gte: this.dayOnly(dto.from) } : {}),
                ...(dto.to ? { lte: this.dayOnly(dto.to) } : {}),
              },
            }
          : {},
        dto.search
          ? { content: { contains: dto.search, mode: 'insensitive' } }
          : {},
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.projectReport.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.projectReport.count({ where }),
    ]);
    const enriched = await this.enrichDeliveryStatus(data);
    return { data: enriched, total };
  }

  async findOne(id: string, user: AuthUser) {
    const report = await this.prisma.projectReport.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!report) throw new NotFoundException('Project report not found');
    await this.assertCanReadReport(report, user);
    return report;
  }

  /**
   * Updates are restricted to the two business-mutable fields:
   * `hours` and `content`. Everything else on the row (project,
   * date, source, Discord metadata, contributor snapshot) is
   * immutable after create — the DTO already rejects attempts to
   * change those at the parser layer, and we belt-and-braces the
   * invariant here.
   */
  async update(id: string, dto: UpdateProjectReportDto, user: AuthUser) {
    const existing = await this.prisma.projectReport.findUnique({
      where: { id },
      select: { id: true, projectId: true, source: true },
    });
    if (!existing) throw new NotFoundException('Project report not found');
    await this.assertCanWriteProject(user, existing.projectId);
    try {
      return await this.prisma.projectReport.update({
        where: { id },
        data: {
          ...(dto.hours !== undefined ? { hours: dto.hours } : {}),
          ...(dto.content !== undefined ? { content: dto.content } : {}),
        },
        include: this.include(),
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  /**
   * Delete is privileged. A project-day report is a team record,
   * not a personal one — Regular Managers cannot withdraw it.
   */
  async remove(id: string, user: AuthUser) {
    if (!scopePolicy.canViewAnyProject(user)) {
      throw new ForbiddenException(
        'Only an Owner / Admin Manager can delete a project report.',
      );
    }
    const existing = await this.prisma.projectReport.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Project report not found');
    await this.prisma.projectReport.delete({ where: { id } });
  }

  /**
   * Bulk delete under the same privilege rule as single-remove. Hits
   * the DB with one `deleteMany` so the operation is atomic — if a
   * caller passes stale ids (ones already gone), `deleteMany` just
   * skips them and reports the actual deleted count rather than
   * throwing. The caller sees how many of the requested ids were
   * live when the delete fired.
   */
  async bulkRemove(ids: string[], user: AuthUser): Promise<{ deleted: number }> {
    if (!scopePolicy.canViewAnyProject(user)) {
      throw new ForbiddenException(
        'Only an Owner / Admin Manager can delete a project report.',
      );
    }
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.projectReport.deleteMany({
      where: { id: { in: ids } },
    });
    return { deleted: result.count };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * MANUAL-side late enqueue. Idempotent via `DiscordDelivery`'s
   * `deliveryKey` UNIQUE (`LATE_REPORT:<reportId>`). Discord-sourced
   * rows own their own enqueue inside `DiscordReportService`.
   */
  private async enqueueLateDeliveryIfNeeded(
    row: Prisma.ProjectReportGetPayload<{
      include: ReturnType<ProjectReportService['include']>;
    }>,
  ): Promise<void> {
    if (row.source !== ProjectReportSource.MANUAL) return;
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { timezone: true, dailyDigestAt: true },
    });
    if (!profile) return;
    const submittedAt = row.createdAt;
    /* Backdated MANUAL reports (reportDate strictly before today's
     * local calendar day) are ALWAYS late — the digest for their
     * reportDate already fired. `isLateReport()` alone misses this
     * case because it only sees `submittedAt`, not the business
     * reportDate the user picked in the CRM form. Without this
     * guard, a backdated row filed between 10:00 and 19:00 Kyiv
     * silently falls through — no late ping, and today's digest
     * does not pick it up (digest filters `reportDate = today`). */
    const todayLocal = localCalendarDate(submittedAt, profile.timezone);
    const isBackdated = row.reportDate.getTime() < todayLocal.getTime();
    if (
      !isBackdated &&
      !isLateReport(submittedAt, profile.timezone, profile.dailyDigestAt)
    ) {
      return;
    }
    const headAuthor = row.contributors[0];
    const authorName = headAuthor
      ? `${headAuthor.firstNameSnapshot} ${headAuthor.lastNameSnapshot}`.trim() ||
        'CRM team'
      : 'CRM team';
    try {
      await this.lateReports.enqueue({
        reportId: row.id,
        projectId: row.projectId,
        projectName: row.project.name,
        discordUserId: '',
        discordUsername: authorName,
        reportDate: row.reportDate,
        hours: row.hours,
        text: row.content ?? '',
        isLate: true,
        submittedAt,
      });
    } catch (err) {
      const message = this.scrubError(err);
      this.logger.warn(
        `late-report enqueue failed for MANUAL report ${row.id}: ${message}`,
      );
    }
  }

  /**
   * Attach a `deliveryVia` + `deliveryStatus` pair to each report row
   * for the list page. Two delivery paths are tracked:
   *
   *   LATE  — per-report ping via `DiscordLateReportService`, keyed
   *           `LATE_REPORT:<reportId>`. Covers backdated and
   *           after-19:00 submissions.
   *   DIGEST — the bulk 19:00 daily digest, keyed
   *           `DAILY_DIGEST_19:<profileId>:<reportDate_YYYY-MM-DD>`.
   *           Covers on-time same-day submissions.
   *
   * Resolution precedence: if a LATE_REPORT row exists it wins
   * (that was the only path for this report). Otherwise we look up
   * the digest row for the report's `reportDate`, but only credit
   * the digest with it when the digest actually fired AFTER this
   * report's `createdAt` (so a backdated row created today for a
   * past day whose digest already fired is correctly reported as
   * `none`, not falsely `digest_sent`).
   */
  private async enrichDeliveryStatus<
    R extends { id: string; reportDate: Date; createdAt: Date },
  >(reports: R[]): Promise<Array<R & {
    deliveryVia: 'late' | 'digest' | null;
    deliveryStatus: 'sent' | 'pending' | 'failed' | 'none';
  }>> {
    if (reports.length === 0) return [];

    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: { id: true, timezone: true, dailyDigestAt: true },
    });
    if (!profile) {
      return reports.map((r) => ({
        ...r,
        deliveryVia: null,
        deliveryStatus: 'none' as const,
      }));
    }

    const lateKeys = reports.map((r) => `LATE_REPORT:${r.id}`);
    const uniqueDates = Array.from(
      new Set(reports.map((r) => r.reportDate.toISOString().slice(0, 10))),
    );
    /* Digest keys follow the scheduler's chunked format:
     *   `DAILY_DIGEST_19:<YYYY-MM-DD>:chunk:<N>`  (NO profileId;
     * `periodKey` is just the ISO date). One digest run may produce
     * multiple chunks for a busy day — the status reads SENT as soon
     * as any chunk is SENT. We query all chunks for all dates in one
     * `startsWith`-based OR so paging doesn't blow up the WHERE size. */
    type DeliveryRow = { deliveryKey: string; status: DiscordDeliveryStatus };
    const lateRows: DeliveryRow[] =
      lateKeys.length > 0
        ? await this.prisma.discordDelivery.findMany({
            where: { deliveryKey: { in: lateKeys } },
            select: { deliveryKey: true, status: true },
          })
        : [];
    const digestChunks: DeliveryRow[] =
      uniqueDates.length > 0
        ? await this.prisma.discordDelivery.findMany({
            where: {
              OR: uniqueDates.map((d) => ({
                deliveryKey: { startsWith: `DAILY_DIGEST_19:${d}:chunk:` },
              })),
            },
            select: { deliveryKey: true, status: true },
          })
        : [];
    const lateByKey = new Map(lateRows.map((d) => [d.deliveryKey, d]));
    /* Aggregate per-date digest status across chunks: SENT wins over
     * everything (digest fired at least partially); otherwise pick
     * FAILED over PENDING over nothing. */
    const digestByDate = new Map<string, DiscordDeliveryStatus>();
    for (const chunk of digestChunks) {
      const m = /^DAILY_DIGEST_19:(\d{4}-\d{2}-\d{2}):chunk:\d+$/.exec(
        chunk.deliveryKey,
      );
      if (!m) continue;
      const date = m[1];
      const prev = digestByDate.get(date);
      if (prev === DiscordDeliveryStatus.SENT) continue;
      if (
        chunk.status === DiscordDeliveryStatus.SENT ||
        prev === undefined ||
        (prev === DiscordDeliveryStatus.PENDING &&
          chunk.status === DiscordDeliveryStatus.FAILED)
      ) {
        digestByDate.set(date, chunk.status);
      }
    }

    const nowUtc = new Date();
    return reports.map((r) => {
      const lateRow = lateByKey.get(`LATE_REPORT:${r.id}`);
      if (lateRow) {
        return {
          ...r,
          deliveryVia: 'late' as const,
          deliveryStatus: this.mapDiscordStatus(lateRow.status),
        };
      }
      const dateKey = r.reportDate.toISOString().slice(0, 10);
      const digestStatus = digestByDate.get(dateKey);
      const deadlineUtc = this.deadlineUtcFor(
        r.reportDate,
        profile.dailyDigestAt,
        profile.timezone,
      );
      const wasInDigestWindow = r.createdAt.getTime() < deadlineUtc.getTime();
      if (digestStatus === DiscordDeliveryStatus.SENT) {
        return {
          ...r,
          deliveryVia: 'digest' as const,
          deliveryStatus: wasInDigestWindow ? ('sent' as const) : ('none' as const),
        };
      }
      if (digestStatus) {
        return {
          ...r,
          deliveryVia: 'digest' as const,
          deliveryStatus: this.mapDiscordStatus(digestStatus),
        };
      }
      /* No digest chunk for this date yet — either the 19:00 cron
       * hasn't fired (future reportDate / today pre-19:00) or it
       * never ran for a past date (profile disabled, downtime, etc.). */
      if (wasInDigestWindow && deadlineUtc.getTime() > nowUtc.getTime()) {
        return {
          ...r,
          deliveryVia: 'digest' as const,
          deliveryStatus: 'pending' as const,
        };
      }
      return {
        ...r,
        deliveryVia: null,
        deliveryStatus: 'none' as const,
      };
    });
  }

  private mapDiscordStatus(
    s: DiscordDeliveryStatus,
  ): 'sent' | 'pending' | 'failed' {
    switch (s) {
      case DiscordDeliveryStatus.SENT:
        return 'sent';
      case DiscordDeliveryStatus.FAILED:
        return 'failed';
      case DiscordDeliveryStatus.PENDING:
      default:
        return 'pending';
    }
  }

  /** UTC moment of `hhmm` on `day` in `timezone`. Mirrors the private
   *  helper the scheduler uses — kept inline here to avoid widening
   *  that module's public surface for a single read-only consumer. */
  private deadlineUtcFor(day: Date, hhmm: string, timezone: string): Date {
    const minutes = parseHHMM(hhmm);
    const anchor = new Date(day.getTime() + 12 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = fmt.formatToParts(anchor);
    const h = Number.parseInt(
      parts.find((p) => p.type === 'hour')?.value ?? '0',
      10,
    );
    const m = Number.parseInt(
      parts.find((p) => p.type === 'minute')?.value ?? '0',
      10,
    );
    const anchorMinutes = h * 60 + m;
    const delta = minutes - anchorMinutes;
    return new Date(anchor.getTime() + delta * 60 * 1000);
  }

  private scrubError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
      .replace(/\/webhooks\/(\d{17,20})\/[^\/\s]+/g, '/webhooks/$1/<redacted>')
      .slice(0, 240);
  }

  private dayOnly(iso: string): Date {
    const d = new Date(iso);
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  private include() {
    return {
      project: { select: { id: true, name: true, status: true } },
      contributors: {
        orderBy: [
          { lastNameSnapshot: Prisma.SortOrder.asc },
          { firstNameSnapshot: Prisma.SortOrder.asc },
          { createdAt: Prisma.SortOrder.asc },
        ],
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    } satisfies Prisma.ProjectReportInclude;
  }

  private buildOrderBy(
    sortBy: ProjectReportSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.ProjectReportOrderByWithRelationInput[] {
    switch (sortBy) {
      case ProjectReportSortBy.reportDate:
        return [{ reportDate: dir }, { createdAt: dir }];
      case ProjectReportSortBy.hours:
        return [{ hours: dir }];
      case ProjectReportSortBy.updatedAt:
        return [{ updatedAt: dir }];
      case ProjectReportSortBy.source:
        // Enum ordering is alphabetical in Postgres text comparison
        // but Prisma preserves the enum definition order; add a
        // stable secondary sort so same-source rows do not shuffle
        // on page boundaries.
        return [{ source: dir }, { reportDate: dir }, { createdAt: dir }];
      case ProjectReportSortBy.createdAt:
      default:
        return [{ createdAt: dir }];
    }
  }

  /**
   * Regular Manager scope: a report is visible iff the caller is
   * currently a member of the project OR appears in the historical
   * contributor snapshot. Owner / Admin Manager (any-scope) see
   * everything.
   */
  private async buildScopeWhere(
    user: AuthUser,
  ): Promise<Prisma.ProjectReportWhereInput> {
    if (scopePolicy.canViewAnyProject(user)) return {};
    const employeeId = await this.resolveSelfEmployeeId(user);
    if (!employeeId) return { id: { in: [] } };
    return {
      OR: [
        { project: { members: { some: { employeeId } } } },
        { contributors: { some: { employeeId } } },
      ],
    };
  }

  private async assertCanReadReport(
    report: {
      projectId: string;
      contributors: Array<{ employeeId: string | null }>;
    },
    user: AuthUser,
  ): Promise<void> {
    if (scopePolicy.canViewAnyProject(user)) return;
    const employeeId = await this.resolveSelfEmployeeId(user);
    if (!employeeId) {
      throw new NotFoundException('Project report not found');
    }
    const isCurrentMember = await this.isCurrentProjectMember(
      report.projectId,
      employeeId,
    );
    const isSnapshotContributor = report.contributors.some(
      (c) => c.employeeId === employeeId,
    );
    if (!isCurrentMember && !isSnapshotContributor) {
      throw new NotFoundException('Project report not found');
    }
  }

  /**
   * Create and update authorisation share one rule: the caller must
   * be a current `ProjectMember` of the target project. Snapshot
   * contributors can still READ, but once removed from the team
   * they lose write access — consistent with "the team at
   * submission is historical; the team now owns new state".
   */
  private async assertCanWriteProject(
    user: AuthUser,
    projectId: string,
  ): Promise<void> {
    if (scopePolicy.canViewAnyProject(user)) return;
    const employeeId = await this.resolveSelfEmployeeId(user);
    if (!employeeId) {
      throw new ForbiddenException('PROJECT_REPORT_ACCESS_DENIED');
    }
    const isMember = await this.isCurrentProjectMember(projectId, employeeId);
    if (!isMember) {
      throw new ForbiddenException(
        'You are not assigned to this project.',
      );
    }
  }

  private async resolveSelfEmployeeId(
    user: AuthUser,
  ): Promise<string | null> {
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    return employee?.id ?? null;
  }

  private async isCurrentProjectMember(
    projectId: string,
    employeeId: string,
  ): Promise<boolean> {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_employeeId: { projectId, employeeId } },
      select: { projectId: true },
    });
    return !!membership;
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new BadRequestException('Project not found');
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof ConflictException) return e;
    if (e instanceof UnprocessableEntityException) return e;
    if (e instanceof BadRequestException) return e;
    if (e instanceof ForbiddenException) return e;
    if (e instanceof NotFoundException) return e;
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        return new ConflictException(
          'A report for this project already exists for the given date.',
        );
      }
      if (e.code === 'P2003') {
        return new BadRequestException('Related record not found');
      }
    }
    return e as Error;
  }
}
