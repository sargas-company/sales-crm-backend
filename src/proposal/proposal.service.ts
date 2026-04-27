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
  chat: true,
  lead: { select: { id: true } },
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
        chat: { create: {} },
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
    return this.prisma.$transaction(async (tx) => {
      const chat = await tx.chat.findUnique({ where: { proposalId: id } });
      if (chat) {
        if (!chat.leadId) {
          await tx.chat.delete({ where: { id: chat.id } });
        } else {
          await tx.chat.update({
            where: { id: chat.id },
            data: { proposalId: null },
          });
        }
      }
      return tx.proposal.delete({ where: { id } });
    });
  }

  async getMessages(proposalId: string) {
    const proposal = await this.prisma.proposal.findUnique({
      where: { id: proposalId },
      include: {
        jobPost: true,
        platform: true,
        lead: {
          select: {
            firstName: true,
            lastName: true,
            companyName: true,
            status: true,
            clientType: true,
            location: true,
          },
        },
      },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    const chat = await this.prisma.chat.findUnique({ where: { proposalId } });
    const messages = chat
      ? await this.prisma.chatMessage.findMany({
          where: { chatId: chat.id },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const { jobPost, platform, lead, ...proposalFields } = proposal;

    return {
      messages,
      context: {
        proposal: {
          title: proposalFields.title,
          status: proposalFields.status,
          proposalType: proposalFields.proposalType,
          boosted: proposalFields.boosted,
          connects: proposalFields.connects,
          boostedConnects: proposalFields.boostedConnects,
          platform: platform ? { id: platform.id, name: platform.title } : null,
          vacancy: proposalFields.vacancy,
          coverLetter: proposalFields.coverLetter,
        },
        jobPost: jobPost
          ? {
              title: jobPost.title,
              description: jobPost.rawText,
              score: jobPost.matchScore,
              gigRadarScore: jobPost.gigRadarScore,
              budget: jobPost.budget,
              source: jobPost.scanner,
              totalSpent: jobPost.totalSpent,
              avgRatePaid: jobPost.avgRatePaid,
              hireRate: jobPost.hireRate,
              location: jobPost.location,
            }
          : null,
        lead: lead
          ? {
              name: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
              companyName: lead.companyName,
              status: lead.status,
              clientType: lead.clientType,
              location: lead.location,
            }
          : null,
      },
    };
  }
}
