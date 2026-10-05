import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLinkedInAccountDto } from './dto/create-linkedin-account.dto';
import { UpdateLinkedInAccountDto } from './dto/update-linkedin-account.dto';
import {
  ListLinkedInAccountsDto,
  LinkedInAccountSortBy,
  SortDir,
} from './dto/list-linkedin-accounts.dto';

const ACCOUNT_INCLUDE = {
  employee: {
    select: { id: true, firstName: true, lastName: true, positions: true },
  },
  _count: { select: { posts: true } },
} as const;

@Injectable()
export class LinkedInAccountService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLinkedInAccountDto) {
    if (dto.employeeId) await this.ensureEmployee(dto.employeeId);
    return this.prisma.linkedInAccount.create({
      data: {
        displayName: dto.displayName.trim(),
        type: dto.type,
        profileUrl: dto.profileUrl.trim(),
        employeeId: dto.employeeId ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        isActive: dto.isActive ?? true,
        note: dto.note ?? null,
      },
      include: ACCOUNT_INCLUDE,
    });
  }

  async findAll(query: ListLinkedInAccountsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const skip = (page - 1) * limit;
    const search = query.search?.trim();

    const where: Prisma.LinkedInAccountWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status === 'active'
        ? { isActive: true }
        : query.status === 'inactive'
          ? { isActive: false }
          : {}),
      ...(search
        ? {
            OR: [
              { displayName: { contains: search, mode: 'insensitive' } },
              { profileUrl: { contains: search, mode: 'insensitive' } },
              { note: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(query.sortBy, query.sortDir);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.linkedInAccount.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: ACCOUNT_INCLUDE,
      }),
      this.prisma.linkedInAccount.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }

  async findOne(id: string) {
    const row = await this.prisma.linkedInAccount.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
    if (!row) throw new NotFoundException('LinkedIn account not found');
    return row;
  }

  async update(id: string, dto: UpdateLinkedInAccountDto) {
    await this.findOne(id);
    if (dto.employeeId) await this.ensureEmployee(dto.employeeId);
    return this.prisma.linkedInAccount.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName.trim() }
          : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.profileUrl !== undefined
          ? { profileUrl: dto.profileUrl.trim() }
          : {}),
        ...(dto.employeeId !== undefined
          ? { employeeId: dto.employeeId || null }
          : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.note !== undefined ? { note: dto.note || null } : {}),
      },
      include: ACCOUNT_INCLUDE,
    });
  }

  async remove(id: string) {
    const acc = await this.prisma.linkedInAccount.findUnique({
      where: { id },
      select: { id: true, _count: { select: { posts: true } } },
    });
    if (!acc) throw new NotFoundException('LinkedIn account not found');
    if (acc._count.posts > 0) {
      throw new ConflictException(
        'Account has existing posts. Archive it instead of deleting.',
      );
    }
    await this.prisma.linkedInAccount.delete({ where: { id } });
  }

  private buildOrderBy(
    sortBy?: LinkedInAccountSortBy,
    sortDir?: SortDir,
  ): Prisma.LinkedInAccountOrderByWithRelationInput {
    const dir = sortDir ?? SortDir.asc;
    switch (sortBy) {
      case LinkedInAccountSortBy.type:
        return { type: dir };
      case LinkedInAccountSortBy.isActive:
        return { isActive: dir };
      case LinkedInAccountSortBy.createdAt:
        return { createdAt: dir };
      case LinkedInAccountSortBy.updatedAt:
        return { updatedAt: dir };
      case LinkedInAccountSortBy.displayName:
      default:
        return { displayName: dir };
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
