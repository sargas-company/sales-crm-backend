import { Injectable, NotFoundException } from '@nestjs/common';

import { LeadStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateLeadDto) {
    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          companyName: dto.companyName,
          clientType: dto.clientType,
          rate: dto.rate,
          location: dto.location,
        },
      });

      await tx.chat.create({ data: { leadId: lead.id } });

      return lead;
    });
  }

  async createFromProposal(
    proposalId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const lead = await tx.lead.create({
      data: { proposalId },
    });

    await tx.chat.updateMany({
      where: { proposalId },
      data: { leadId: lead.id },
    });

    return lead;
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

    return this.prisma.$transaction(async (tx) => {
      const chat = await tx.chat.findUnique({ where: { leadId: id } });
      if (chat) {
        if (!chat.proposalId) {
          await tx.chat.delete({ where: { id: chat.id } });
        } else {
          await tx.chat.update({
            where: { id: chat.id },
            data: { leadId: null },
          });
        }
      }
      return tx.lead.delete({ where: { id } });
    });
  }

  async getMessages(leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        proposal: {
          include: { jobPost: true, platform: true },
        },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const chat = await this.prisma.chat.findUnique({ where: { leadId } });
    const messages = chat
      ? await this.prisma.chatMessage.findMany({
          where: { chatId: chat.id },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    const { proposal, ...leadFields } = lead;
    const jobPost = proposal?.jobPost ?? null;
    const platform = proposal?.platform ?? null;

    return {
      messages,
      context: {
        lead: {
          name: [leadFields.firstName, leadFields.lastName]
            .filter(Boolean)
            .join(' '),
          companyName: leadFields.companyName,
          status: leadFields.status,
          clientType: leadFields.clientType,
          location: leadFields.location,
        },
        proposal: proposal
          ? {
              title: proposal.title,
              status: proposal.status,
              proposalType: proposal.proposalType,
              boosted: proposal.boosted,
              connects: proposal.connects,
              boostedConnects: proposal.boostedConnects,
              platform: platform ? { id: platform.id, name: platform.title } : null,
              vacancy: proposal.vacancy,
              coverLetter: proposal.coverLetter,
            }
          : null,
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
              aiResponse: jobPost.aiResponse,
            }
          : null,
      },
    };
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
