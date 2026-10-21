import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreatePositionDto } from './dto/create-position.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

@Injectable()
export class PositionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePositionDto) {
    const existingByTitle = await this.prisma.position.findUnique({
      where: { title: dto.title },
    });
    if (existingByTitle) throw new ConflictException(`Title "${dto.title}" is already taken`);

    const existingBySlug = await this.prisma.position.findUnique({
      where: { slug: dto.slug },
    });
    if (existingBySlug) throw new ConflictException(`Slug "${dto.slug}" is already taken`);

    return this.prisma.position.create({
      data: { title: dto.title, slug: dto.slug },
    });
  }

  findAll() {
    return this.prisma.position.findMany({ orderBy: { title: 'asc' } });
  }

  async findOne(id: string) {
    const position = await this.prisma.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundException('Position not found');
    return position;
  }

  async update(id: string, dto: UpdatePositionDto) {
    await this.findOne(id);

    if (dto.title) {
      const conflict = await this.prisma.position.findUnique({
        where: { title: dto.title },
      });
      if (conflict && conflict.id !== id)
        throw new ConflictException(`Title "${dto.title}" is already taken`);
    }
    if (dto.slug) {
      const conflict = await this.prisma.position.findUnique({
        where: { slug: dto.slug },
      });
      if (conflict && conflict.id !== id)
        throw new ConflictException(`Slug "${dto.slug}" is already taken`);
    }

    return this.prisma.position.update({
      where: { id },
      data: { title: dto.title, slug: dto.slug },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.position.delete({ where: { id } });
  }
}
