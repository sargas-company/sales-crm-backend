import { Injectable, NotFoundException } from '@nestjs/common';

import { LeadStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import {
  LeadSortBy,
  LeadSortDirection,
  ListLeadsDto,
} from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateLeadDto) {
    return this.prisma.lead.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        companyName: dto.companyName,
        clientType: dto.clientType,
        rate: dto.rate,
        location: dto.location,
      },
    });
  }

  createFromProposal(
    proposalId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.lead.create({
      data: { proposalId },
    });
  }

  async findAll(dto: ListLeadsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? LeadSortDirection.desc;

    const where: Prisma.LeadWhereInput = dto.search
      ? {
          OR: [
            { firstName: { contains: dto.search, mode: 'insensitive' } },
            { lastName: { contains: dto.search, mode: 'insensitive' } },
            { companyName: { contains: dto.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: { proposal: { select: { id: true, title: true } } },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: LeadSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.LeadOrderByWithRelationInput {
    switch (sortBy) {
      case LeadSortBy.number:
        return { number: dir };
      case LeadSortBy.firstName:
        return { firstName: { sort: dir, nulls: 'last' } };
      case LeadSortBy.clientType:
        return { clientType: { sort: dir, nulls: 'last' } };
      case LeadSortBy.status:
        return { status: dir };
      case LeadSortBy.rate:
        return { rate: { sort: dir, nulls: 'last' } };
      case LeadSortBy.location:
        return { location: { sort: dir, nulls: 'last' } };
      case LeadSortBy.repliedAt:
        return { repliedAt: dir };
      case LeadSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async findOne(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: { proposal: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async remove(id: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');

    return this.prisma.lead.delete({ where: { id } });
  }

  async update(id: string, dto: UpdateLeadDto) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');

    const now = new Date();
    const isBecomingHold =
      dto.status === LeadStatus.hold && lead.status !== LeadStatus.hold;
    const isBecomingAccepted =
      dto.status === LeadStatus.accept_contract &&
      lead.status !== LeadStatus.accept_contract;

    return this.prisma.lead.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        companyName: dto.companyName,
        status: dto.status,
        clientType: dto.clientType,
        rate: dto.rate,
        location: dto.location,
        ...(isBecomingHold && { holdAt: now }),
        ...(isBecomingAccepted && { acceptedAt: now }),
      },
    });
  }
}
