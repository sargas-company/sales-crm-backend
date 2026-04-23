import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PromptType } from '@prisma/client';

import { CHAT_FALLBACK_PROMPT } from '../ai/prompts/chat-fallback.prompt';
import { JOB_EVALUATION_PROMPT } from '../ai/prompts/job-evaluation.prompt';
import { JOB_GATEKEEPER_PROMPT } from '../ai/prompts/job-gatekeeper.prompt';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromptDto } from './dto/create-prompt.dto';
import { QueryPromptsDto } from './dto/query-prompts.dto';
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

  async getChatPrompt(): Promise<string> {
    const cached = this.cacheGet<string>('prompt:chat');
    if (cached) return cached;

    try {
      const system = await this.prisma.prompt.findFirst({
        where: { type: PromptType.CHAT_SYSTEM, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      if (system) {
        this.cacheSet('prompt:chat', system.content);
        return system.content;
      }

      const fallback = await this.prisma.prompt.findFirst({
        where: { type: PromptType.CHAT_FALLBACK, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      const value = fallback?.content ?? CHAT_FALLBACK_PROMPT;
      this.cacheSet('prompt:chat', value);
      return value;
    } catch (error) {
      this.logger.error('Failed to fetch prompt for type CHAT', error.stack);
      this.logger.warn('Using fallback chat prompt');
      this.cacheSet('prompt:chat', CHAT_FALLBACK_PROMPT);
      return CHAT_FALLBACK_PROMPT;
    }
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
    const where = {
      ...(filter.type !== undefined && { type: filter.type }),
      ...(filter.isActive !== undefined && { isActive: filter.isActive }),
    };

    const [data, total] = await Promise.all([
      this.prisma.prompt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.prompt.count({ where }),
    ]);

    return { data, total };
  }

  async createPrompt(dto: CreatePromptDto) {
    const title = dto.title.trim();
    if (!title) throw new BadRequestException('Title cannot be empty');
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Content cannot be empty');

    return this.prisma.prompt.create({
      data: {
        type: dto.type,
        title,
        content,
        version: 1,
        isActive: false,
      },
    });
  }

  async updatePrompt(id: string, dto: UpdatePromptDto) {
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('Content cannot be empty');

    const existing = await this.findOrThrow(id);
    const nextVersion = (existing.version ?? 1) + 1;

    if (existing.isActive) {
      const [, created] = await this.prisma.$transaction([
        this.prisma.prompt.update({
          where: { id },
          data: { isActive: false },
        }),
        this.prisma.prompt.create({
          data: {
            type: existing.type,
            title: existing.title,
            content,
            version: nextVersion,
            isActive: true,
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
      },
    });
  }

  async activatePrompt(id: string) {
    const prompt = await this.findOrThrow(id);
    const [, activated] = await this.prisma.$transaction([
      this.prisma.prompt.updateMany({
        where: { type: prompt.type, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.prompt.update({
        where: { id },
        data: { isActive: true },
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
