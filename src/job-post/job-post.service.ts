import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { Prisma, ProposalSource, ProposalType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ConvertToProposalDto } from './dto/convert-to-proposal.dto';
import { JobPostStatsDto } from './dto/job-post-stats.dto';
import {
  JobPostSortBy,
  JobPostSortDirection,
  ListJobPostsDto,
} from './dto/list-job-posts.dto';

const JOB_POST_SELECT = {
  id: true,
  chatId: true,
  messageId: true,
  status: true,
  decision: true,
  matchScore: true,
  priority: true,
  createdAt: true,
  processedAt: true,
  title: true,
  jobUrl: true,
  scanner: true,
  gigRadarScore: true,
  location: true,
  budget: true,
  totalSpent: true,
  avgRatePaid: true,
  hireRate: true,
  hSkillsKeywords: true,
  proposal: { select: { id: true } },
} satisfies Prisma.JobPostSelect;

const withViewSelect = (userId: string) =>
  ({
    ...JOB_POST_SELECT,
    views: {
      where: { userId },
      select: { viewedAt: true },
      take: 1,
    },
  }) satisfies Prisma.JobPostSelect;

/** Shape returned to the API: flatten `views[0].viewedAt` into a top-level
 * nullable string so callers see one record per post, same shape as before
 * with one extra field. */
type JobPostRow = Prisma.JobPostGetPayload<{
  select: ReturnType<typeof withViewSelect>;
}>;

const flattenViewedAt = <R extends JobPostRow>({
  views,
  ...rest
}: R): Omit<R, 'views'> & { viewedAt: string | null } => ({
  ...rest,
  viewedAt: views?.[0]?.viewedAt?.toISOString() ?? null,
});

@Injectable()
export class JobPostService {
  private readonly logger = new Logger(JobPostService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(dto: ListJobPostsDto, userId: string) {
    const {
      decision,
      priority,
      minScore,
      maxScore,
      sortBy,
      sortDirection = JobPostSortDirection.desc,
      search,
      status = 'PROCESSED',
      limit = 20,
      offset = 0,
      createdFrom,
      createdTo,
    } = dto;

    const scoreFilterActive = minScore !== undefined || maxScore !== undefined;
    const sortByScore = sortBy === JobPostSortBy.matchScore;

    const matchScoreFilter: Prisma.IntNullableFilter = {
      ...(scoreFilterActive || sortByScore ? { not: null } : {}),
      ...(minScore !== undefined ? { gte: minScore } : {}),
      ...(maxScore !== undefined ? { lte: maxScore } : {}),
    };

    const where: Prisma.JobPostWhereInput = {
      status,
      ...(decision && { decision }),
      ...(priority && { priority }),
      ...(Object.keys(matchScoreFilter).length
        ? { matchScore: matchScoreFilter }
        : {}),
      ...(search
        ? { title: { contains: search, mode: 'insensitive' } }
        : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
              ...(createdTo ? { lte: new Date(createdTo) } : {}),
            },
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(sortBy, sortDirection);

    const [data, total] = await Promise.all([
      this.prisma.jobPost.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        select: withViewSelect(userId),
      }),
      this.prisma.jobPost.count({ where }),
    ]);

    this.logger.log(`findAll: returned ${data.length} of ${total}`);

    return { data: data.map(flattenViewedAt), meta: { total, limit, offset } };
  }

  private buildOrderBy(
    sortBy: JobPostSortBy | undefined,
    sortDirection: JobPostSortDirection,
  ): Prisma.JobPostOrderByWithRelationInput {
    const dir: Prisma.SortOrder = sortDirection;
    switch (sortBy) {
      case JobPostSortBy.matchScore:
        // matchScore-null rows are already excluded from the WHERE clause
        // when sorting by score, so plain direction is enough here.
        return { matchScore: dir };
      case JobPostSortBy.title:
        return { title: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.status:
        return { status: dir };
      case JobPostSortBy.budget:
        return { budget: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.location:
        return { location: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.totalSpent:
        return { totalSpent: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.avgRatePaid:
        return { avgRatePaid: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.hireRate:
        return { hireRate: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.scanner:
        return { scanner: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.processedAt:
        return { processedAt: { sort: dir, nulls: 'last' } };
      case JobPostSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async getStats(dto: JobPostStatsDto) {
    const dateFilter: Prisma.DateTimeFilter = {
      ...(dto.from ? { gte: new Date(dto.from) } : {}),
      ...(dto.to ? { lte: new Date(dto.to) } : {}),
    };
    const hasDates = dto.from || dto.to;
    const baseWhere: Prisma.JobPostWhereInput = hasDates
      ? { createdAt: dateFilter }
      : {};
    const processedWhere: Prisma.JobPostWhereInput = {
      ...baseWhere,
      status: 'PROCESSED',
    };

    const [byStatus, byDecision, byPriority, scoreAgg, ranges, medianResult] =
      await Promise.all([
        this.prisma.jobPost.groupBy({
          by: ['status'],
          where: baseWhere,
          _count: true,
        }),
        this.prisma.jobPost.groupBy({
          by: ['decision'],
          where: { ...processedWhere, decision: { not: null } },
          _count: true,
        }),
        this.prisma.jobPost.groupBy({
          by: ['priority'],
          where: { ...processedWhere, priority: { not: null } },
          _count: true,
        }),
        this.prisma.jobPost.aggregate({
          where: { ...processedWhere, matchScore: { not: null } },
          _avg: { matchScore: true },
          _min: { matchScore: true },
          _max: { matchScore: true },
        }),
        Promise.all([
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 85 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 70, lt: 85 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 55, lt: 70 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 40, lt: 55 } },
          }),
          this.prisma.jobPost.count({
            where: { ...processedWhere, matchScore: { gte: 0, lt: 40 } },
          }),
        ]),
        this.prisma.$queryRaw<[{ median: number }]>`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "matchScore")::int AS median
          FROM "JobPost"
          WHERE status = 'PROCESSED'
            AND "matchScore" IS NOT NULL
            ${hasDates && dto.from ? Prisma.sql`AND "createdAt" >= ${new Date(dto.from)}` : Prisma.empty}
            ${hasDates && dto.to ? Prisma.sql`AND "createdAt" <= ${new Date(dto.to)}` : Prisma.empty}
        `,
      ]);

    const toMap = <T extends string>(
      rows: { _count: number; [k: string]: unknown }[],
      key: string,
    ): Record<string, number> =>
      Object.fromEntries(rows.map((r) => [r[key] as T, r._count]));

    return {
      period: { from: dto.from ?? null, to: dto.to ?? null },
      total: byStatus.reduce((s, r) => s + r._count, 0),
      byStatus: toMap(byStatus, 'status'),
      decisions: toMap(byDecision, 'decision'),
      priority: toMap(byPriority, 'priority'),
      score: {
        avg:
          scoreAgg._avg.matchScore !== null
            ? Math.round(scoreAgg._avg.matchScore)
            : null,
        median: medianResult[0]?.median ?? null,
        min: scoreAgg._min.matchScore,
        max: scoreAgg._max.matchScore,
      },
      scoreRanges: {
        '85_100': ranges[0],
        '70_84': ranges[1],
        '55_69': ranges[2],
        '40_54': ranges[3],
        '0_39': ranges[4],
      },
    };
  }

  async findOne(id: string, userId: string) {
    const jobPost = await this.prisma.jobPost.findUnique({
      where: { id },
      include: {
        proposal: { select: { id: true } },
        views: {
          where: { userId },
          select: { viewedAt: true },
          take: 1,
        },
      },
    });

    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);

    const { views, ...rest } = jobPost;
    return {
      ...rest,
      viewedAt: views?.[0]?.viewedAt?.toISOString() ?? null,
    };
  }

  async markViewed(id: string, userId: string) {
    const exists = await this.prisma.jobPost.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException(`JobPost ${id} not found`);

    const row = await this.prisma.jobPostView.upsert({
      where: { userId_jobPostId: { userId, jobPostId: id } },
      update: { viewedAt: new Date() },
      create: { userId, jobPostId: id },
      select: { viewedAt: true },
    });

    return { viewedAt: row.viewedAt.toISOString() };
  }

  async remove(id: string) {
    const jobPost = await this.prisma.jobPost.findUnique({ where: { id } });
    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);
    await this.prisma.jobPost.delete({ where: { id } });
  }

  /**
   * Bulk delete under the same permission as single-remove. Stale
   * ids are silently skipped — the response reports the actual
   * matched row count via `deleted`.
   */
  async bulkRemove(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.jobPost.deleteMany({
      where: { id: { in: ids } },
    });
    return { deleted: result.count };
  }

  async convertToProposal(
    id: string,
    dto: ConvertToProposalDto,
    userId: string,
  ) {
    const jobPost = await this.prisma.jobPost.findUnique({
      where: { id },
      include: { proposal: true },
    });

    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);
    if (jobPost.proposal)
      throw new ConflictException('Proposal already exists for this job post');

    const upwork = await this.prisma.platform.findUniqueOrThrow({
      where: { slug: 'upwork' },
    });

    const isBid = dto.proposalType === ProposalType.Bid;

    return this.prisma.proposal.create({
      data: {
        title: jobPost.title ?? jobPost.rawText.slice(0, 100),
        jobUrl: jobPost.jobUrl,
        vacancy: jobPost.rawText,
        proposalType: dto.proposalType,
        source: ProposalSource.telegram,
        platformId: upwork.id,
        boosted: isBid ? (dto.boosted ?? false) : false,
        connects: isBid ? (dto.connects ?? 0) : 0,
        boostedConnects: isBid && dto.boosted ? (dto.boostedConnects ?? 0) : 0,
        userId,
        jobPostId: jobPost.id,
      },
    });
  }
}
