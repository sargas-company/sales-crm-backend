import { Injectable, NotFoundException } from '@nestjs/common';
import { CounterpartyType, Prisma } from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCounterpartyDto } from './dto/create-counterparty.dto';
import {
  CounterpartySortBy,
  CounterpartySortDirection,
  ListCounterpartiesDto,
} from './dto/list-counterparties.dto';
import { UpdateCounterpartyDto } from './dto/update-counterparty.dto';

@Injectable()
export class CounterpartyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCounterpartyDto, user: AuthUser) {
    scopePolicy.assertCanManageType(user, dto.type);
    return this.prisma.counterparty.create({ data: dto });
  }

  async findAll(dto: ListCounterpartiesDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? CounterpartySortDirection.desc;
    const visibleTypes = scopePolicy.visibleTypes(user);
    // Honor caller-provided `type`, but never widen beyond what the
    // scope policy allows: a Regular Manager asking for contractors
    // still gets an empty list, not a 403.
    const effectiveTypes = dto.type
      ? visibleTypes.filter((t) => t === dto.type)
      : visibleTypes;

    const where: Prisma.CounterpartyWhereInput = {
      type: { in: effectiveTypes },
      ...(dto.search
        ? {
            OR: [
              { firstName: { contains: dto.search, mode: 'insensitive' } },
              { lastName: { contains: dto.search, mode: 'insensitive' } },
              { company: { contains: dto.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.counterparty.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
      }),
      this.prisma.counterparty.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: CounterpartySortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.CounterpartyOrderByWithRelationInput {
    switch (sortBy) {
      case CounterpartySortBy.firstName:
        return { firstName: dir };
      case CounterpartySortBy.type:
        return { type: dir };
      case CounterpartySortBy.updatedAt:
        return { updatedAt: dir };
      case CounterpartySortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async findOne(id: string, user: AuthUser) {
    const counterparty = await this.prisma.counterparty.findUnique({ where: { id } });
    if (!counterparty) throw new NotFoundException('Counterparty not found');
    scopePolicy.assertCanReadType(user, counterparty.type);
    return counterparty;
  }

  async update(id: string, dto: UpdateCounterpartyDto, user: AuthUser) {
    const existing = await this.prisma.counterparty.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Counterparty not found');
    // Guard on both the row's current scope and any scope change.
    scopePolicy.assertCanManageType(user, existing.type);
    const nextType: CounterpartyType = (dto.type ??
      existing.type) as CounterpartyType;
    if (nextType !== existing.type) {
      scopePolicy.assertCanManageType(user, nextType);
    }
    return this.prisma.counterparty.update({ where: { id }, data: dto });
  }

  async remove(id: string, user: AuthUser) {
    const existing = await this.prisma.counterparty.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Counterparty not found');
    scopePolicy.assertCanManageType(user, existing.type);
    return this.prisma.counterparty.delete({ where: { id } });
  }
}
