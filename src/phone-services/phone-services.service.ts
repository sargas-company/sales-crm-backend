import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreatePhoneServiceDto } from './dto/create-phone-service.dto';
import { UpdatePhoneServiceDto } from './dto/update-phone-service.dto';

@Injectable()
export class PhoneServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q?: string) {
    const where: Prisma.PhoneServiceWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {};
    const rows = await this.prisma.phoneService.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { bindings: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      bindingsCount: r._count.bindings,
    }));
  }

  async get(id: string) {
    const row = await this.prisma.phoneService.findUnique({
      where: { id },
      include: { _count: { select: { bindings: true } } },
    });
    if (!row) throw new NotFoundException('Phone service not found');
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      bindingsCount: row._count.bindings,
    };
  }

  async create(dto: CreatePhoneServiceDto) {
    const name = dto.name.trim();
    const slug = dto.slug.trim();
    if (!name) throw new BadRequestException('name required');
    if (!slug) throw new BadRequestException('slug required');
    const clash = await this.prisma.phoneService.findUnique({ where: { slug } });
    if (clash) throw new ConflictException(`Slug "${slug}" is already taken`);
    return this.prisma.phoneService.create({ data: { name, slug } });
  }

  async update(id: string, dto: UpdatePhoneServiceDto) {
    const existing = await this.prisma.phoneService.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Phone service not found');
    if (dto.slug && dto.slug !== existing.slug) {
      const clash = await this.prisma.phoneService.findUnique({
        where: { slug: dto.slug },
      });
      if (clash) throw new ConflictException(`Slug "${dto.slug}" is already taken`);
    }
    return this.prisma.phoneService.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug.trim() } : {}),
      },
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.phoneService.findUnique({
      where: { id },
      include: { _count: { select: { bindings: true } } },
    });
    if (!existing) throw new NotFoundException('Phone service not found');
    if (existing._count.bindings > 0) {
      throw new ConflictException(
        `Cannot delete "${existing.name}" — ${existing._count.bindings} phone binding(s) still reference it`,
      );
    }
    await this.prisma.phoneService.delete({ where: { id } });
  }
}
