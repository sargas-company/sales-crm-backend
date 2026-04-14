import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { v4 as uuidv4 } from 'uuid';

import { EmbeddingService } from '../embedding/embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBaseKnowledgeDto } from './dto/create-base-knowledge.dto';
import { UpdateBaseKnowledgeDto } from './dto/update-base-knowledge.dto';
import { BaseKnowledge, PaginatedResult } from './base-knowledge.types';

const RELEVANCE_THRESHOLD = 1.2;

@Injectable()
export class BaseKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  async create(data: CreateBaseKnowledgeDto): Promise<BaseKnowledge> {
    const { title, description, category } = data;

    if (!title?.trim()) throw new BadRequestException('Title is required');
    if (!description?.trim()) throw new BadRequestException('Description is required');
    if (!category?.trim()) throw new BadRequestException('Category is required');

    const vector = await this.embedding.createEmbedding(
      `${title} ${description}`,
    );
    const vectorStr = `[${vector.join(',')}]`;
    const id = uuidv4();
    const now = new Date();

    const rows = await this.prisma.$queryRaw<BaseKnowledge[]>`
      INSERT INTO "BaseKnowledge" (id, title, description, category, embedding, "createdAt", "updatedAt")
      VALUES (
        ${id}, ${title}, ${description}, ${category},
        ${vectorStr}::vector, ${now}, ${now}
      )
      RETURNING id, title, description, category, "createdAt", "updatedAt"
    `;

    return rows[0];
  }

  async findAll(page: number, limit: number): Promise<PaginatedResult<BaseKnowledge>> {
    const offset = (page - 1) * limit;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<BaseKnowledge[]>`
        SELECT id, title, description, category, "createdAt", "updatedAt"
        FROM "BaseKnowledge"
        ORDER BY "createdAt" DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) FROM "BaseKnowledge"
      `,
    ]);

    return { data: rows, total: Number(countRows[0].count) };
  }

  async findOne(id: string): Promise<BaseKnowledge> {
    const rows = await this.prisma.$queryRaw<BaseKnowledge[]>`
      SELECT id, title, description, category, "createdAt", "updatedAt"
      FROM "BaseKnowledge"
      WHERE id = ${id}
    `;
    if (!rows[0]) throw new NotFoundException('BaseKnowledge entry not found');
    return rows[0];
  }

  async update(
    id: string,
    data: UpdateBaseKnowledgeDto,
  ): Promise<BaseKnowledge> {
    const current = await this.findOne(id);

    const title = data.title ?? (current.title as string);
    const description = data.description ?? (current.description as string);
    const category = data.category ?? (current.category as string);

    const vector = await this.embedding.createEmbedding(
      `${title} ${description}`,
    );
    const vectorStr = `[${vector.join(',')}]`;
    const now = new Date();

    const rows = await this.prisma.$queryRaw<BaseKnowledge[]>`
      UPDATE "BaseKnowledge"
      SET
        title = ${title},
        description = ${description},
        category = ${category},
        embedding = ${vectorStr}::vector,
        "updatedAt" = ${now}
      WHERE id = ${id}
      RETURNING id, title, description, category, "createdAt", "updatedAt"
    `;

    return rows[0];
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.baseKnowledge.delete({ where: { id } });
  }

  async searchRelevant(text: string): Promise<BaseKnowledge[]> {
    const normalized = text?.trim();
    if (!normalized) return [];

    const vector = await this.embedding.createEmbedding(normalized);
    const vectorStr = `[${vector.join(',')}]`;

    const rows = await this.prisma.$queryRaw<
      (BaseKnowledge & { distance: number })[]
    >`
      SELECT id, title, description, category, "createdAt", "updatedAt",
             embedding <-> ${vectorStr}::vector AS distance
      FROM "BaseKnowledge"
      WHERE embedding <-> ${vectorStr}::vector < ${RELEVANCE_THRESHOLD}
      ORDER BY embedding <-> ${vectorStr}::vector
      LIMIT 5
    `;

    return rows.map(
      ({ id, title, description, category, createdAt, updatedAt }) => ({
        id,
        title,
        description,
        category,
        createdAt,
        updatedAt,
      }),
    );
  }
}
