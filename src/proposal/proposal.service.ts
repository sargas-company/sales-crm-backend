import { Injectable, NotFoundException } from '@nestjs/common';

import { ProposalStatus, ProposalType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';

@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateProposalDto, userId: string) {
    const isBid = dto.proposalType === ProposalType.Bid;
    return this.prisma.proposal.create({
      data: {
        title: dto.title,
        manager: dto.manager,
        account: dto.account,
        proposalType: dto.proposalType,
        platform: dto.platform,
        jobUrl: dto.jobUrl,
        boosted: isBid ? (dto.boosted ?? false) : false,
        connects: isBid ? (dto.connects ?? 0) : 0,
        boostedConnects: isBid && dto.boosted ? (dto.boostedConnects ?? 0) : 0,
        coverLetter: dto.coverLetter,
        vacancy: dto.vacancy,
        userId,
      },
    });
  }

  async findAll(userId: string, page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.proposal.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.proposal.count({ where: { userId } }),
    ]);

    return { data, total };
  }

  async findOne(id: string, userId: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, userId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  async update(id: string, dto: UpdateProposalDto, userId: string) {
    const current = await this.findOne(id, userId);
    const effectiveType = dto.proposalType ?? current.proposalType;
    const isBid = effectiveType === ProposalType.Bid;
    const sentAt = dto.status === ProposalStatus.Sent ? new Date() : undefined;

    const bidFields = isBid
      ? {
          boosted: dto.boosted,
          connects: dto.connects,
          ...(dto.boosted !== undefined && {
            boostedConnects: dto.boosted ? (dto.boostedConnects ?? 0) : 0,
          }),
        }
      : { boosted: false, connects: 0, boostedConnects: 0 };

    return this.prisma.proposal.update({
      where: { id },
      data: {
        title: dto.title,
        manager: dto.manager,
        account: dto.account,
        proposalType: dto.proposalType,
        status: dto.status,
        platform: dto.platform,
        jobUrl: dto.jobUrl,
        ...bidFields,
        coverLetter: dto.coverLetter,
        vacancy: dto.vacancy,
        ...(sentAt !== undefined && { sentAt }),
      },
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.prisma.proposal.delete({ where: { id } });
  }

  async getMessages(proposalId: string, userId: string) {
    await this.findOne(proposalId, userId);
    return this.prisma.chatMessage.findMany({
      where: { proposalId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
