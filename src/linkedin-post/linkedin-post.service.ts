import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLinkedInPostDto } from './dto/create-linkedin-post.dto';
import { UpdateLinkedInPostDto } from './dto/update-linkedin-post.dto';
import {
  ListLinkedInPostsDto,
  LinkedInPostSortBy,
  SortDir,
} from './dto/list-linkedin-posts.dto';

const POST_INCLUDE = {
  account: {
    select: { id: true, displayName: true, type: true, avatarUrl: true, profileUrl: true },
  },
  idea: { select: { id: true, title: true } },
  author: {
    select: { id: true, firstName: true, lastName: true, positions: true },
  },
} as const;

type PostRow = Prisma.LinkedInPostGetPayload<{ include: typeof POST_INCLUDE }>;

@Injectable()
export class LinkedInPostService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLinkedInPostDto) {
    this.validateStatus(dto.status, dto.scheduledAt, dto.publishedAt);
    await this.ensureAccount(dto.accountId);
    if (dto.ideaId) await this.ensureIdea(dto.ideaId);
    if (dto.authorId) await this.ensureEmployee(dto.authorId);

    const post = await this.prisma.linkedInPost.create({
      data: {
        internalTitle: dto.internalTitle.trim(),
        accountId: dto.accountId,
        ideaId: dto.ideaId ?? null,
        authorId: dto.authorId ?? null,
        body: dto.body,
        hook: dto.hook ?? null,
        firstComment: dto.firstComment ?? null,
        hashtags: dto.hashtags ?? [],
        format: dto.format ?? 'TEXT',
        language: dto.language ?? 'en',
        targetAudience: dto.targetAudience ?? null,
        contentPillar: dto.contentPillar ?? null,
        // Serialise validated class instances to plain JSON for Prisma.
        attachments:
          dto.attachments !== undefined
            ? dto.attachments.map((a) => ({
                url: a.url,
                ...(a.name !== undefined ? { name: a.name } : {}),
                ...(a.type !== undefined ? { type: a.type } : {}),
              }))
            : Prisma.JsonNull,
        externalLink: dto.externalLink ?? null,
        status: dto.status ?? 'DRAFT',
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null,
        linkedInUrl: dto.linkedInUrl ?? null,
        note: dto.note ?? null,
        impressions: dto.impressions ?? 0,
        reactions: dto.reactions ?? 0,
        comments: dto.comments ?? 0,
        reposts: dto.reposts ?? 0,
        clicks: dto.clicks ?? 0,
        followersGained: dto.followersGained ?? 0,
        leadsGenerated: dto.leadsGenerated ?? 0,
      },
      include: POST_INCLUDE,
    });

    // If a source Idea is linked and it is not archived, mark it CONVERTED.
    if (dto.ideaId) {
      await this.prisma.linkedInIdea.updateMany({
        where: { id: dto.ideaId, status: { in: ['NEW', 'IN_PROGRESS'] } },
        data: { status: 'CONVERTED' },
      });
    }

    return this.decorate(post);
  }

  async findAll(query: ListLinkedInPostsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();

    const rangeStart = query.rangeStart ? new Date(query.rangeStart) : null;
    const rangeEnd = query.rangeEnd ? new Date(query.rangeEnd) : null;

    const where: Prisma.LinkedInPostWhereInput = {
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.format ? { format: query.format } : {}),
      ...(query.language ? { language: query.language } : {}),
      ...(rangeStart && rangeEnd
        ? {
            OR: [
              { scheduledAt: { gte: rangeStart, lt: rangeEnd } },
              { publishedAt: { gte: rangeStart, lt: rangeEnd } },
            ],
          }
        : {}),
      ...(search
        ? {
            OR: [
              { internalTitle: { contains: search, mode: 'insensitive' } },
              { body: { contains: search, mode: 'insensitive' } },
              { hook: { contains: search, mode: 'insensitive' } },
              { hashtags: { has: search } },
              { account: { displayName: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.linkedInPost.findMany({
        where,
        orderBy: this.buildOrderBy(query.sortBy, query.sortDir),
        skip,
        take: limit,
        include: POST_INCLUDE,
      }),
      this.prisma.linkedInPost.count({ where }),
    ]);

    return {
      data: rows.map((r) => this.decorate(r)),
      total,
      page,
      limit,
    };
  }

  async findOne(id: string) {
    const row = await this.prisma.linkedInPost.findUnique({
      where: { id },
      include: POST_INCLUDE,
    });
    if (!row) throw new NotFoundException('LinkedIn post not found');
    return this.decorate(row);
  }

  async update(id: string, dto: UpdateLinkedInPostDto) {
    const existing = await this.prisma.linkedInPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('LinkedIn post not found');

    const nextStatus = dto.status ?? existing.status;
    const nextScheduled = dto.scheduledAt
      ? new Date(dto.scheduledAt)
      : dto.scheduledAt === null
        ? null
        : existing.scheduledAt;
    const nextPublished = dto.publishedAt
      ? new Date(dto.publishedAt)
      : dto.publishedAt === null
        ? null
        : existing.publishedAt;
    this.validateStatus(
      nextStatus,
      nextScheduled?.toISOString() ?? undefined,
      nextPublished?.toISOString() ?? undefined,
    );

    if (dto.accountId) await this.ensureAccount(dto.accountId);
    if (dto.ideaId) await this.ensureIdea(dto.ideaId);
    if (dto.authorId) await this.ensureEmployee(dto.authorId);

    const post = await this.prisma.linkedInPost.update({
      where: { id },
      data: {
        ...(dto.internalTitle !== undefined
          ? { internalTitle: dto.internalTitle.trim() }
          : {}),
        ...(dto.accountId !== undefined ? { accountId: dto.accountId } : {}),
        ...(dto.ideaId !== undefined ? { ideaId: dto.ideaId || null } : {}),
        ...(dto.authorId !== undefined ? { authorId: dto.authorId || null } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.hook !== undefined ? { hook: dto.hook || null } : {}),
        ...(dto.firstComment !== undefined
          ? { firstComment: dto.firstComment || null }
          : {}),
        ...(dto.hashtags !== undefined ? { hashtags: dto.hashtags } : {}),
        ...(dto.format !== undefined ? { format: dto.format } : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
        ...(dto.targetAudience !== undefined
          ? { targetAudience: dto.targetAudience || null }
          : {}),
        ...(dto.contentPillar !== undefined
          ? { contentPillar: dto.contentPillar || null }
          : {}),
        ...(dto.attachments !== undefined
          ? {
              attachments: dto.attachments.map((a) => ({
                url: a.url,
                ...(a.name !== undefined ? { name: a.name } : {}),
                ...(a.type !== undefined ? { type: a.type } : {}),
              })),
            }
          : {}),
        ...(dto.externalLink !== undefined
          ? { externalLink: dto.externalLink || null }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.scheduledAt !== undefined
          ? { scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null }
          : {}),
        ...(dto.publishedAt !== undefined
          ? { publishedAt: dto.publishedAt ? new Date(dto.publishedAt) : null }
          : {}),
        ...(dto.linkedInUrl !== undefined
          ? { linkedInUrl: dto.linkedInUrl || null }
          : {}),
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
        ...(dto.impressions !== undefined ? { impressions: dto.impressions } : {}),
        ...(dto.reactions !== undefined ? { reactions: dto.reactions } : {}),
        ...(dto.comments !== undefined ? { comments: dto.comments } : {}),
        ...(dto.reposts !== undefined ? { reposts: dto.reposts } : {}),
        ...(dto.clicks !== undefined ? { clicks: dto.clicks } : {}),
        ...(dto.followersGained !== undefined
          ? { followersGained: dto.followersGained }
          : {}),
        ...(dto.leadsGenerated !== undefined
          ? { leadsGenerated: dto.leadsGenerated }
          : {}),
      },
      include: POST_INCLUDE,
    });
    return this.decorate(post);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.linkedInPost.delete({ where: { id } });
  }

  private decorate(post: PostRow) {
    const totalEngagement =
      post.reactions + post.comments + post.reposts + post.clicks;
    const engagementRate =
      post.impressions > 0 ? (totalEngagement / post.impressions) * 100 : 0;
    return { ...post, engagementRate: Number(engagementRate.toFixed(2)) };
  }

  private validateStatus(
    status?: string,
    scheduledAt?: string,
    publishedAt?: string,
  ) {
    if (status === 'SCHEDULED' && !scheduledAt) {
      throw new BadRequestException('SCHEDULED status requires scheduledAt');
    }
    if (status === 'PUBLISHED' && !publishedAt) {
      throw new BadRequestException('PUBLISHED status requires publishedAt');
    }
  }

  private buildOrderBy(
    sortBy?: LinkedInPostSortBy,
    sortDir?: SortDir,
  ): Prisma.LinkedInPostOrderByWithRelationInput {
    const dir = sortDir ?? SortDir.desc;
    switch (sortBy) {
      case LinkedInPostSortBy.internalTitle:
        return { internalTitle: dir };
      case LinkedInPostSortBy.status:
        return { status: dir };
      case LinkedInPostSortBy.format:
        return { format: dir };
      case LinkedInPostSortBy.scheduledAt:
        return { scheduledAt: dir };
      case LinkedInPostSortBy.publishedAt:
        return { publishedAt: dir };
      case LinkedInPostSortBy.impressions:
        return { impressions: dir };
      case LinkedInPostSortBy.createdAt:
        return { createdAt: dir };
      case LinkedInPostSortBy.updatedAt:
      default:
        return { updatedAt: dir };
    }
  }

  private async ensureAccount(accountId: string) {
    const acc = await this.prisma.linkedInAccount.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!acc) throw new BadRequestException('LinkedIn account not found');
  }

  private async ensureIdea(ideaId: string) {
    const idea = await this.prisma.linkedInIdea.findUnique({
      where: { id: ideaId },
      select: { id: true },
    });
    if (!idea) throw new BadRequestException('LinkedIn idea not found');
  }

  private async ensureEmployee(employeeId: string) {
    const exists = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!exists) throw new BadRequestException('Employee not found');
  }
}
