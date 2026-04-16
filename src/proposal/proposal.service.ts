import { Injectable, NotFoundException } from '@nestjs/common';

import { ProposalStatus } from '@prisma/client';

import { LeadService } from '../lead/lead.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';

@Injectable()
export class ProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadService: LeadService,
  ) {}

  create(dto: CreateProposalDto, userId: string) {
    return this.prisma.proposal.create({
      data: {
        title: dto.title,
        manager: dto.manager,
        account: dto.account,
        proposalType: dto.proposalType,
        platform: dto.platform,
        jobUrl: dto.jobUrl,
        boosted: dto.boosted,
        connects: dto.connects,
        coverLetter: dto.coverLetter,
        vacancy: dto.vacancy,
        comment: dto.comment,
        context: dto.context,
        userId,
      },
    });
  }

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.proposal.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.proposal.count(),
    ]);

    return { data, total };
  }

  async findOne(id: string) {
    const proposal = await this.prisma.proposal.findUnique({
      where: { id },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  async update(id: string, dto: UpdateProposalDto) {
    const proposal = await this.findOne(id);

    const now = new Date();
    const sentAt = dto.status === ProposalStatus.Sent ? now : undefined;
    const isBecomingReplied =
      dto.status === ProposalStatus.Replied && proposal.status !== ProposalStatus.Replied;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.proposal.update({
        where: { id },
        data: {
          title: dto.title,
          manager: dto.manager,
          account: dto.account,
          proposalType: dto.proposalType,
          status: dto.status,
          platform: dto.platform,
          jobUrl: dto.jobUrl,
          boosted: dto.boosted,
          connects: dto.connects,
          coverLetter: dto.coverLetter,
          vacancy: dto.vacancy,
          comment: dto.comment,
          context: dto.context,
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
