import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectReportSource } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { projectReportLockKey } from '../project-report/project-report.lock';
import { logicalReportDate, isLateReport } from './logical-date';
import { DiscordLateReportService } from './discord-late-report.service';

export interface DiscordReportResult {
  reportId: string;
  projectId: string;
  projectName: string;
  discordUserId: string;
  discordUsername: string;
  reportDate: Date;
  hours: number;
  text: string;
  isLate: boolean;
  submittedAt: Date;
}

/**
 * `/report` adapter. Writes a `ProjectReport` row with
 * `source = DISCORD`, no Employee FK, and provenance pulled directly
 * from the Discord payload (`discord_user_id` + display name).
 *
 * The business rule enforced here on top of the DB-level invariants:
 *
 *   - channel → project resolution: fail if `Project.discordChannelId`
 *     doesn't match this channel;
 *   - one DISCORD report per (project, logical date): partial unique
 *     index `ProjectReport_discord_uq`;
 *   - no MANUAL + DISCORD mix on the same (project, logical date):
 *     explicit cross-source check inside the same advisory lock the
 *     CRM-side create uses.
 */
@Injectable()
export class DiscordReportService {
  private readonly logger = new Logger(DiscordReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lateReports: DiscordLateReportService,
  ) {}

  async createFromDiscord(args: {
    discordChannelId: string;
    discordUserId: string;
    discordUsername: string;
    hours: number;
    text: string;
    now: Date;
    cutoffHour: number;
    timezone: string;
    /**
     * Daily-digest deadline from the active DiscordProfile
     * (`dailyDigestAt`, "HH:MM"). The late-vs-normal predicate must
     * agree with the daily-digest filter down to the minute; the
     * daily digest and this call read the same `profile.dailyDigestAt`
     * so there is no 59-second race around 19:00.
     */
    dailyDigestAt: string;
  }): Promise<DiscordReportResult> {
    const project = await this.prisma.project.findUnique({
      where: { discordChannelId: args.discordChannelId },
      select: { id: true, name: true },
    });
    if (!project) {
      throw new NotFoundException(
        'This channel is not linked to a project. Set its Discord channel ID on the project in the admin.',
      );
    }

    const reportDate = logicalReportDate({
      now: args.now,
      cutoffHour: args.cutoffHour,
      timezone: args.timezone,
    });
    const lockKey = projectReportLockKey(project.id, reportDate);
    let createdId: string | null = null;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Shared with the CRM MANUAL path — serialises MANUAL ↔ DISCORD
        // creates for the same (project, date) so cross-source rows
        // can't both land. `pg_advisory_xact_lock` returns `void`, so
        // we have to use `$executeRaw`.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

        const existingSameSource = await tx.projectReport.findFirst({
          where: {
            projectId: project.id,
            reportDate,
            source: ProjectReportSource.DISCORD,
          },
          select: { id: true },
        });
        if (existingSameSource) {
          throw new ConflictException(
            `A report for ${project.name} today already exists.`,
          );
        }

        const manualExists = await tx.projectReport.findFirst({
          where: {
            projectId: project.id,
            reportDate,
            source: ProjectReportSource.MANUAL,
          },
          select: { id: true },
        });
        if (manualExists) {
          throw new ConflictException(
            `A CRM-filed report for ${project.name} already exists for this date; the Discord flow would double-count hours.`,
          );
        }

        const created = await tx.projectReport.create({
          data: {
            projectId: project.id,
            reportDate,
            hours: args.hours,
            content: args.text.trim(),
            source: ProjectReportSource.DISCORD,
            discordUserId: args.discordUserId,
            discordUsername: args.discordUsername,
          },
          select: { id: true },
        });
        createdId = created.id;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `A report for ${project.name} today already exists.`,
        );
      }
      if (
        err instanceof Prisma.PrismaClientUnknownRequestError &&
        err.message.includes('ProjectReport_source_shape_chk')
      ) {
        throw new BadRequestException('Report payload violates source shape.');
      }
      throw err;
    }

    const isLate = isLateReport(args.now, args.timezone, args.dailyDigestAt);
    const result: DiscordReportResult = {
      reportId: createdId!,
      projectId: project.id,
      projectName: project.name,
      discordUserId: args.discordUserId,
      discordUsername: args.discordUsername,
      reportDate,
      hours: args.hours,
      text: args.text.trim(),
      isLate,
      submittedAt: args.now,
    };

    if (isLate) {
      try {
        await this.lateReports.enqueue(result);
      } catch (err) {
        this.logger.warn(
          `late-report enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}
