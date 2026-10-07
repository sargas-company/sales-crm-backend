import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectReportSource } from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { DiscordLateReportService } from '../discord-integration/discord-late-report.service';
import { isLateReport } from '../discord-integration/logical-date';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectReportDto } from './dto/create-project-report.dto';
import {
  ListProjectReportsDto,
  ProjectReportSortBy,
  ProjectReportSortDirection,
} from './dto/list-project-reports.dto';
import { UpdateProjectReportDto } from './dto/update-project-report.dto';
import { projectReportLockKey } from './project-report.lock';

@Injectable()
export class ProjectReportService {
  private readonly logger = new Logger(ProjectReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lateReports: DiscordLateReportService,
  ) {}

  async create(dto: CreateProjectReportDto, user: AuthUser) {
    await this.assertProjectAndEmployeeExist(dto.projectId, dto.employeeId);
    await this.assertMemberOfProject(dto.projectId, dto.employeeId);
    await this.assertAuthorScope(user, dto.employeeId, dto.projectId);

    const reportDate = this.dayOnly(dto.reportDate);
    const lockKey = projectReportLockKey(dto.projectId, reportDate);

    let created: Prisma.ProjectReportGetPayload<{
      include: ReturnType<ProjectReportService['include']>;
    }>;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // Same lock the Discord adapter takes — a MANUAL create and a
        // DISCORD create for the same (project, date) are serialised,
        // which is what the cross-source invariant depends on.
        // `pg_advisory_xact_lock` returns `void`, so `$executeRaw`
        // (which doesn't try to deserialize rows) is required.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        const discordExists = await tx.projectReport.findFirst({
          where: {
            projectId: dto.projectId,
            reportDate,
            source: ProjectReportSource.DISCORD,
          },
          select: { id: true },
        });
        if (discordExists) {
          throw new ConflictException(
            'A Discord-sourced report already exists for this project on this date; the two sources would double-count hours.',
          );
        }
        return tx.projectReport.create({
          data: {
            projectId: dto.projectId,
            employeeId: dto.employeeId,
            reportDate,
            hours: dto.hours,
            content: dto.content,
            source: ProjectReportSource.MANUAL,
          },
          include: this.include(),
        });
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }

    // Late-report notification parity with the Discord `/report`
    // path: MANUAL creates filed after the active profile's
    // `dailyDigestAt` deadline enqueue the same `LATE_REPORT:<id>`
    // delivery row. Enqueue failures are swallowed with a sanitised
    // log — the ProjectReport row is already committed; a failed
    // Discord notification must never roll it back.
    await this.enqueueLateDeliveryIfNeeded(created);

    return created;
  }

  /**
   * MANUAL-side late enqueue. Idempotent via `DiscordDelivery`'s
   * `deliveryKey` UNIQUE (`LATE_REPORT:<reportId>`), so a crash-and-
   * replay cannot create a second row.
   *
   * DISCORD-sourced rows never reach this method; the Discord
   * `/report` path owns its own enqueue inside `DiscordReportService`.
   */
  private async enqueueLateDeliveryIfNeeded(
    row: Prisma.ProjectReportGetPayload<{ include: ReturnType<ProjectReportService['include']> }>,
  ): Promise<void> {
    if (row.source !== ProjectReportSource.MANUAL) return;
    const profile = await this.prisma.discordProfile.findFirst({
      where: { active: true },
      select: {
        timezone: true,
        dailyDigestAt: true,
      },
    });
    if (!profile) return;
    const submittedAt = row.createdAt;
    if (!isLateReport(submittedAt, profile.timezone, profile.dailyDigestAt)) {
      return;
    }
    const authorName = row.employee
      ? `${row.employee.firstName} ${row.employee.lastName}`
      : 'CRM user';
    try {
      await this.lateReports.enqueue({
        reportId: row.id,
        projectId: row.projectId,
        projectName: row.project.name,
        // MANUAL rows have no Discord user id/handle. These fields
        // are informational — the late-report embed only renders
        // `authorName`.
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

  private scrubError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/Bot\s+[A-Za-z0-9._-]+/g, 'Bot <redacted>')
      .replace(/\/webhooks\/(\d{17,20})\/[^\/\s]+/g, '/webhooks/$1/<redacted>')
      .slice(0, 240);
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
        dto.employeeId ? { employeeId: dto.employeeId } : {},
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
    return { data, total };
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
   * Updates do NOT emit a Discord notification by design.
   *
   * The old Laravel admin's `ReportObserver::updated()` sent a
   * `"Report updated"` embed on every row edit, which produced
   * channel noise (one message per silent correction, including the
   * manager fixing their own typos). The CRM-era policy is: an edit
   * is a correction, not a new event — nothing fires. If the business
   * ever wants a notification on specific transitions (e.g. hours
   * crossing some threshold), add it as a deliberate event, don't
   * replay the Laravel-era blanket update spam.
   */
  async update(id: string, dto: UpdateProjectReportDto, user: AuthUser) {
    const existing = await this.prisma.projectReport.findUnique({
      where: { id },
      select: { id: true, employeeId: true, projectId: true, source: true },
    });
    if (!existing) throw new NotFoundException('Project report not found');
    if (existing.source === ProjectReportSource.DISCORD) {
      // Discord-sourced rows are owned by the Discord flow; CRM-side
      // Regular Managers cannot author-scope them (there's no Employee
      // link). Owner/Admin can only read/delete via `/remove`.
      throw new ForbiddenException(
        'Discord-sourced reports cannot be edited through the CRM form.',
      );
    }
    if (!existing.employeeId) {
      // Belt-and-braces — the CHECK constraint already rules this out.
      throw new BadRequestException('MANUAL report has no author.');
    }
    await this.assertAuthorScope(user, existing.employeeId, existing.projectId);

    try {
      return await this.prisma.projectReport.update({
        where: { id },
        data: {
          ...(dto.reportDate !== undefined
            ? { reportDate: this.dayOnly(dto.reportDate) }
            : {}),
          ...(dto.hours !== undefined ? { hours: dto.hours } : {}),
          ...(dto.content !== undefined ? { content: dto.content } : {}),
          // `source` is intentionally NOT in UpdateProjectReportDto — it
          // can never change through the normal update flow.
        },
        include: this.include(),
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async remove(id: string, user: AuthUser) {
    const existing = await this.prisma.projectReport.findUnique({
      where: { id },
      select: { id: true, employeeId: true, projectId: true, source: true },
    });
    if (!existing) throw new NotFoundException('Project report not found');
    if (existing.source === ProjectReportSource.DISCORD) {
      if (!scopePolicy.canViewAnyProject(user)) {
        throw new ForbiddenException(
          'Only an Owner / Admin Manager can delete a Discord-sourced report.',
        );
      }
    } else {
      if (!existing.employeeId) {
        throw new BadRequestException('MANUAL report has no author.');
      }
      await this.assertAuthorScope(user, existing.employeeId, existing.projectId);
    }
    await this.prisma.projectReport.delete({ where: { id } });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private dayOnly(iso: string): Date {
    const d = new Date(iso);
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  private include(): Prisma.ProjectReportInclude {
    return {
      project: { select: { id: true, name: true, status: true } },
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          positions: true,
          userId: true,
        },
      },
    };
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
      case ProjectReportSortBy.createdAt:
      default:
        return [{ createdAt: dir }];
    }
  }

  private async buildScopeWhere(
    user: AuthUser,
  ): Promise<Prisma.ProjectReportWhereInput> {
    if (scopePolicy.canViewAnyProject(user)) return {};
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!employee) return { id: { in: [] } };
    // Regular Managers see their own MANUAL reports. Discord-sourced
    // rows have no Employee link and are only visible to users who
    // can view any project (checked above).
    return { employeeId: employee.id };
  }

  private async assertCanReadReport(
    report: { employeeId: string | null; projectId: string; source: ProjectReportSource },
    user: AuthUser,
  ): Promise<void> {
    if (scopePolicy.canViewAnyProject(user)) return;
    if (report.source === ProjectReportSource.DISCORD) {
      throw new NotFoundException('Project report not found');
    }
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!employee || employee.id !== report.employeeId) {
      throw new NotFoundException('Project report not found');
    }
  }

  private async assertAuthorScope(
    user: AuthUser,
    employeeId: string,
    projectId: string,
  ): Promise<void> {
    if (scopePolicy.canViewAnyProject(user)) return;
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!employee) {
      throw new ForbiddenException('PROJECT_REPORT_ACCESS_DENIED');
    }
    if (employee.id !== employeeId) {
      throw new ForbiddenException('You can only manage your own reports');
    }
    const membership = await this.prisma.projectMember.findUnique({
      where: {
        projectId_employeeId: { projectId, employeeId: employee.id },
      },
      select: { projectId: true },
    });
    if (!membership) {
      throw new ForbiddenException('You are not assigned to this project');
    }
  }

  private async assertProjectAndEmployeeExist(
    projectId: string,
    employeeId: string,
  ): Promise<void> {
    const [project, employee] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      }),
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true },
      }),
    ]);
    if (!project) throw new BadRequestException('Project not found');
    if (!employee) throw new BadRequestException('Employee not found');
  }

  private async assertMemberOfProject(
    projectId: string,
    employeeId: string,
  ): Promise<void> {
    const membership = await this.prisma.projectMember.findUnique({
      where: {
        projectId_employeeId: { projectId, employeeId },
      },
      select: { projectId: true },
    });
    if (!membership) {
      throw new BadRequestException(
        'Employee is not assigned to this project',
      );
    }
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        return new ConflictException(
          'A report already exists for this employee, project and date',
        );
      }
      if (e.code === 'P2003') {
        return new BadRequestException('Related record not found');
      }
    }
    return e as Error;
  }
}
