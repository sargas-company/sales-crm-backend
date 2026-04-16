import { Injectable, NotFoundException } from '@nestjs/common';

import { ProposalStatus, ProposalType } from '@prisma/client';

import { LeadService } from '../lead/lead.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';

const USER_SELECT = { id: true, email: true, firstName: true, lastName: true };
const PROPOSAL_INCLUDE = {
  user: { select: USER_SELECT },
  account: { include: { platform: true } },
  platform: true,
} as const;

@Injectable()
export class ProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadService: LeadService,
  ) {}

  create(dto: CreateProposalDto, userId: string) {
    const isBid = dto.proposalType === ProposalType.Bid;

    return this.prisma.proposal.create({
      data: {
        title: dto.title,
        accountId: dto.accountId,
        platformId: dto.platformId,
        proposalType: dto.proposalType,
        jobUrl: dto.jobUrl,
        boosted: isBid ? (dto.boosted ?? false) : false,
        connects: isBid ? (dto.connects ?? 0) : 0,
        boostedConnects: isBid && dto.boosted ? (dto.boostedConnects ?? 0) : 0,
        coverLetter: dto.coverLetter,
        vacancy: dto.vacancy,
        userId,
      },
      include: PROPOSAL_INCLUDE,
    });
  }

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.proposal.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: PROPOSAL_INCLUDE,
      }),
      this.prisma.proposal.count(),
    ]);

    return { data, total };
  }

  async findOne(id: string) {
    const proposal = await this.prisma.proposal.findUnique({
      where: { id },
      include: PROPOSAL_INCLUDE,
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  async update(id: string, dto: UpdateProposalDto) {
    const current = await this.findOne(id);
    const effectiveType = dto.proposalType ?? current.proposalType;
    const isBid = effectiveType === ProposalType.Bid;
    const sentAt = dto.status === ProposalStatus.Sent ? new Date() : undefined;
    const isBecomingReplied =
      dto.status === ProposalStatus.Replied &&
      current.status !== ProposalStatus.Replied;

    const bidFields = isBid
      ? {
          boosted: dto.boosted,
          connects: dto.connects,
          ...(dto.boosted !== undefined && {
            boostedConnects: dto.boosted ? (dto.boostedConnects ?? 0) : 0,
          }),
        }
      : { boosted: false, connects: 0, boostedConnects: 0 };

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.proposal.update({
        where: { id },
        include: PROPOSAL_INCLUDE,
        data: {
          title: dto.title,
          accountId: dto.accountId,
          platformId: dto.platformId,
          proposalType: dto.proposalType,
          status: dto.status,
          jobUrl: dto.jobUrl,
          ...bidFields,
          coverLetter: dto.coverLetter,
          vacancy: dto.vacancy,
          ...(sentAt !== undefined && { sentAt }),
        },
      });

      if (isBecomingReplied) {
        await this.leadService.createFromProposal(id, tx);
      }

      return updated;
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.proposal.delete({ where: { id } });
  }

  async getMessages(proposalId: string) {
    await this.findOne(proposalId);
    return this.prisma.chatMessage.findMany({
      where: { proposalId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
