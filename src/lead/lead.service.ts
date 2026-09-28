import { Injectable, NotFoundException } from '@nestjs/common';

import { LeadStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
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

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: { proposal: { select: { id: true, title: true } } },
      }),
      this.prisma.lead.count(),
    ]);

    return { data, total };
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
