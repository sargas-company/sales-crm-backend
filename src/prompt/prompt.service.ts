import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PromptType } from '@prisma/client';

import { JOB_EVALUATION_PROMPT } from '../ai/prompts/job-evaluation.prompt';
import { JOB_GATEKEEPER_PROMPT } from '../ai/prompts/job-gatekeeper.prompt';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromptDto } from './dto/create-prompt.dto';
import {
  PromptSortBy,
  PromptSortDirection,
  QueryPromptsDto,
} from './dto/query-prompts.dto';
import { UpdatePromptDto } from './dto/update-prompt.dto';

@Injectable()
export class PromptService {
  private readonly logger = new Logger(PromptService.name);
  private readonly CACHE_TTL = 60_000;
  private readonly cache = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a user id to a display name like "Vadim C." for the
   *  createdBy / updatedBy audit columns. Returns null when the user
   *  isn't found so the write stays nullable instead of blocking. */
  private async userLabel(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    if (!u) return null;
    const initial = (u.lastName ?? '').trim().slice(0, 1).toUpperCase();
    return initial ? `${u.firstName} ${initial}.` : u.firstName;
  }

  private cacheGet<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private cacheSet(key: string, value: unknown): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.CACHE_TTL });
  }

  getGatekeeperPrompt(): Promise<string> {
    return this.getActiveOrFallback(
      PromptType.JOB_GATEKEEPER,
      JOB_GATEKEEPER_PROMPT,
    );
  }

  getEvaluationPrompt(): Promise<string> {
    return this.getActiveOrFallback(
      PromptType.JOB_EVALUATION,
      JOB_EVALUATION_PROMPT,
    );
  }

  getPromptById(id: string) {
    return this.findOrThrow(id);
  }

  async getPrompts(filter: QueryPromptsDto) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 10;
    const dir: Prisma.SortOrder =
      filter.sortDirection ?? PromptSortDirection.desc;

    const where: Prisma.PromptWhereInput = {
      ...(filter.type !== undefined && { type: filter.type }),
      ...(filter.isActive !== undefined && { isActive: filter.isActive }),
      ...(filter.search
        ? { title: { contains: filter.search, mode: 'insensitive' } }
        : {}),
    };

    const orderBy = this.buildOrderBy(filter.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.prompt.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.prompt.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: PromptSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.PromptOrderByWithRelationInput {
    switch (sortBy) {
      case PromptSortBy.title:
        return { title: dir };
      case PromptSortBy.type:
        return { type: dir };
      case PromptSortBy.version:
        return { version: { sort: dir, nulls: 'last' } };
      case PromptSortBy.isActive:
        return { isActive: dir };
      case PromptSortBy.createdBy:
        return { createdBy: { sort: dir, nulls: 'last' } };
      case PromptSortBy.updatedAt:
        return { updatedAt: dir };
      case PromptSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async createPrompt(dto: CreatePromptDto, actorUserId: string) {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Title cannot be empty');
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Content cannot be empty');

    const actor = await this.userLabel(actorUserId);
    return this.prisma.prompt.create({
      data: {
        type: dto.type,
        title,
        content,
        version: 1,
        isActive: false,
        createdBy: actor,
        updatedBy: actor,
      },
    });
  }

  async updatePrompt(
    id: string,
    dto: UpdatePromptDto,
    actorUserId: string,
  ) {
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Content cannot be empty');

    const existing = await this.findOrThrow(id);
    const nextVersion = (existing.version ?? 1) + 1;
    const actor = await this.userLabel(actorUserId);

    if (existing.isActive) {
      const [, created] = await this.prisma.$transaction([
        this.prisma.prompt.update({
          where: { id },
          data: { isActive: false, updatedBy: actor },
        }),
        this.prisma.prompt.create({
          data: {
            type: existing.type,
            title: existing.title,
            content,
            version: nextVersion,
            isActive: true,
            createdBy: actor,
            updatedBy: actor,
          },
        }),
      ]);
      this.cache.clear();
      return created;
    }

    return this.prisma.prompt.create({
      data: {
        type: existing.type,
        title: existing.title,
        content,
        version: nextVersion,
        isActive: false,
        createdBy: actor,
        updatedBy: actor,
      },
    });
  }

  async activatePrompt(id: string, actorUserId: string) {
    const prompt = await this.findOrThrow(id);
    const actor = await this.userLabel(actorUserId);
    const [, activated] = await this.prisma.$transaction([
      this.prisma.prompt.updateMany({
        where: { type: prompt.type, isActive: true },
        data: { isActive: false, updatedBy: actor },
      }),
      this.prisma.prompt.update({
        where: { id },
        data: { isActive: true, updatedBy: actor },
      }),
    ]);
    this.cache.clear();
    return activated;
  }

  async deletePrompt(id: string) {
    const prompt = await this.findOrThrow(id);
    if (prompt.isActive)
      throw new BadRequestException('Cannot delete an active prompt');

    await this.prisma.prompt.delete({ where: { id } });
    this.cache.clear();
  }

  private async getActiveOrFallback(
    type: PromptType,
    fallback: string,
  ): Promise<string> {
    const key = `prompt:${type}:content`;
    const cached = this.cacheGet<string>(key);
    if (cached) return cached;

    try {
      const prompt = await this.prisma.prompt.findFirst({
        where: { type, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      const value = prompt?.content ?? fallback;
      this.cacheSet(key, value);
      return value;
    } catch (error) {
      this.logger.error(`Failed to fetch prompt for type ${type}`, error.stack);
      this.logger.warn(`Using fallback prompt for type ${type}`);
      this.cacheSet(key, fallback);
      return fallback;
    }
  }

  private async findOrThrow(id: string) {
    const prompt = await this.prisma.prompt.findUnique({ where: { id } });
    if (!prompt) throw new NotFoundException(`Prompt ${id} not found`);
    return prompt;
  }
}
