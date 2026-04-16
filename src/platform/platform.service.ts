import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePlatformDto) {
    const existing = await this.prisma.platform.findUnique({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException(`Slug "${dto.slug}" is already taken`);

    return this.prisma.platform.create({
      data: { title: dto.title, slug: dto.slug, imageUrl: dto.imageUrl },
    });
  }

  findAll() {
    return this.prisma.platform.findMany({ orderBy: { title: 'asc' } });
  }

  async findOne(id: string) {
    const platform = await this.prisma.platform.findUnique({ where: { id } });
    if (!platform) throw new NotFoundException('Platform not found');
    return platform;
  }

  async findBySlug(slug: string) {
    const platform = await this.prisma.platform.findUnique({ where: { slug } });
    if (!platform) throw new NotFoundException(`Platform "${slug}" not found`);
    return platform;
  }

  async update(id: string, dto: UpdatePlatformDto) {
    await this.findOne(id);

    if (dto.slug) {
      const conflict = await this.prisma.platform.findUnique({ where: { slug: dto.slug } });
      if (conflict && conflict.id !== id)
        throw new ConflictException(`Slug "${dto.slug}" is already taken`);
    }

    return this.prisma.platform.update({
      where: { id },
      data: { title: dto.title, slug: dto.slug, imageUrl: dto.imageUrl },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.platform.delete({ where: { id } });
  }
}
