import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ListKnowledgeDto } from './dto/list-knowledge.dto';

@Injectable()
export class KnowledgeQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(dto: ListKnowledgeDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;

    const where = dto.category ? { category: dto.category } : undefined;

    const [data, total] = await Promise.all([
      this.prisma.knowledgeDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          title: true,
          category: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.knowledgeDocument.count({ where }),
    ]);

    return { data, total };
  }

  async findById(id: string) {
    const doc = await this.prisma.knowledgeDocument.findUnique({
      where: { id },
    });
    if (!doc) throw new NotFoundException('Knowledge document not found');
    return doc;
  }
}
