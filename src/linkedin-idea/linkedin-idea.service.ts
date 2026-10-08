import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLinkedInIdeaDto } from './dto/create-linkedin-idea.dto';
import { UpdateLinkedInIdeaDto } from './dto/update-linkedin-idea.dto';
import {
  ListLinkedInIdeasDto,
  LinkedInIdeaSortBy,
  SortDir,
} from './dto/list-linkedin-ideas.dto';

const IDEA_INCLUDE = {
  owner: {
    select: { id: true, firstName: true, lastName: true, positions: true },
  },
  posts: {
    select: {
      id: true,
      internalTitle: true,
      status: true,
      publishedAt: true,
      scheduledAt: true,
    },
    orderBy: { createdAt: 'desc' as const },
  },
  _count: { select: { posts: true } },
} as const;

@Injectable()
export class LinkedInIdeaService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLinkedInIdeaDto) {
    if (dto.ownerId) await this.ensureEmployee(dto.ownerId);
    return this.prisma.linkedInIdea.create({
      data: {
        title: dto.title.trim(),
        content: dto.content,
        hook: dto.hook ?? null,
        targetAudience: dto.targetAudience ?? null,
        contentPillar: dto.contentPillar ?? null,
        suggestedFormat: dto.suggestedFormat ?? null,
        language: dto.language ?? 'en',
        priority: dto.priority ?? 'MEDIUM',
        status: dto.status ?? 'NEW',
        tags: dto.tags ?? [],
        referenceLinks: dto.referenceLinks ?? [],
        attachments: (dto.attachments as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        ownerId: dto.ownerId ?? null,
        plannedDate: dto.plannedDate ? new Date(dto.plannedDate) : null,
        note: dto.note ?? null,
      },
      include: IDEA_INCLUDE,
    });
  }

  async findAll(query: ListLinkedInIdeasDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();

    const where: Prisma.LinkedInIdeaWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.language ? { language: query.language } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { content: { contains: search, mode: 'insensitive' } },
              { hook: { contains: search, mode: 'insensitive' } },
              { tags: { has: search } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.linkedInIdea.findMany({
        where,
        orderBy: this.buildOrderBy(query.sortBy, query.sortDir),
        skip,
        take: limit,
        include: IDEA_INCLUDE,
      }),
      this.prisma.linkedInIdea.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  async findOne(id: string) {
    const row = await this.prisma.linkedInIdea.findUnique({
      where: { id },
      include: IDEA_INCLUDE,
    });
    if (!row) throw new NotFoundException('LinkedIn idea not found');
    return row;
  }

  async update(id: string, dto: UpdateLinkedInIdeaDto) {
    await this.findOne(id);
    if (dto.ownerId) await this.ensureEmployee(dto.ownerId);
    return this.prisma.linkedInIdea.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.hook !== undefined ? { hook: dto.hook || null } : {}),
        ...(dto.targetAudience !== undefined
          ? { targetAudience: dto.targetAudience || null }
          : {}),
        ...(dto.contentPillar !== undefined
          ? { contentPillar: dto.contentPillar || null }
          : {}),
        ...(dto.suggestedFormat !== undefined
          ? { suggestedFormat: dto.suggestedFormat }
          : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(dto.referenceLinks !== undefined
          ? { referenceLinks: dto.referenceLinks }
          : {}),
        ...(dto.attachments !== undefined
          ? { attachments: dto.attachments as Prisma.InputJsonValue }
          : {}),
        ...(dto.ownerId !== undefined ? { ownerId: dto.ownerId || null } : {}),
        ...(dto.plannedDate !== undefined
          ? { plannedDate: dto.plannedDate ? new Date(dto.plannedDate) : null }
          : {}),
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
      },
      include: IDEA_INCLUDE,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    // Posts.ideaId gets SET NULL by FK; the posts themselves survive.
    await this.prisma.linkedInIdea.delete({ where: { id } });
  }

  /**
   * Bulk delete under the same permission as single-remove. Stale
   * ids are silently skipped — the response reports the actual
   * matched row count via `deleted`. LinkedInPost.ideaId gets
   * SET NULL by FK; posts survive.
   */
  async bulkRemove(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.linkedInIdea.deleteMany({
      where: { id: { in: ids } },
    });
    return { deleted: result.count };
  }

  private buildOrderBy(
    sortBy?: LinkedInIdeaSortBy,
    sortDir?: SortDir,
  ): Prisma.LinkedInIdeaOrderByWithRelationInput {
    const dir = sortDir ?? SortDir.desc;
    switch (sortBy) {
      case LinkedInIdeaSortBy.title:
        return { title: dir };
      case LinkedInIdeaSortBy.status:
        return { status: dir };
      case LinkedInIdeaSortBy.priority:
        return { priority: dir };
      case LinkedInIdeaSortBy.plannedDate:
        return { plannedDate: dir };
      case LinkedInIdeaSortBy.createdAt:
        return { createdAt: dir };
      case LinkedInIdeaSortBy.updatedAt:
      default:
        return { updatedAt: dir };
    }
  }

  private async ensureEmployee(employeeId: string) {
    const exists = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!exists) throw new BadRequestException('Employee not found');
  }
}
