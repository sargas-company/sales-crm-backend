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
import { JobPostSortBy, ListJobPostsDto } from './dto/list-job-posts.dto';

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
} satisfies Prisma.JobPostSelect;

@Injectable()
export class JobPostService {
  private readonly logger = new Logger(JobPostService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(dto: ListJobPostsDto) {
    const {
      decision,
      priority,
      minScore,
      maxScore,
      sortBy,
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
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
              ...(createdTo ? { lte: new Date(createdTo) } : {}),
            },
          }
        : {}),
    };

    const orderBy: Prisma.JobPostOrderByWithRelationInput = sortByScore
      ? { matchScore: 'desc' }
      : { createdAt: 'desc' };

    const [data, total] = await Promise.all([
      this.prisma.jobPost.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        select: JOB_POST_SELECT,
      }),
      this.prisma.jobPost.count({ where }),
    ]);

    this.logger.log(`findAll: returned ${data.length} of ${total}`);

    return { data, meta: { total, limit, offset } };
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

  async findOne(id: string) {
    const jobPost = await this.prisma.jobPost.findUnique({
      where: { id },
    });

    if (!jobPost) throw new NotFoundException(`JobPost ${id} not found`);

    return jobPost;
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
        chat: { create: {} },
      },
    });
  }
}
