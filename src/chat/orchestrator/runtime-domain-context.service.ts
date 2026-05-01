import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { DomainContext } from './types';

@Injectable()
export class RuntimeDomainContextService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveChat(proposalId: string, userId: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id: proposalId, userId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    const chat = await this.prisma.chat.findUnique({ where: { proposalId } });
    if (!chat) throw new NotFoundException('Chat not found');

    return chat;
  }

  async load(
    proposalId: string | null,
    leadId: string | null,
  ): Promise<DomainContext> {
    const [proposal, lead] = await Promise.all([
      proposalId
        ? this.prisma.proposal.findUnique({
            where: { id: proposalId },
            include: { jobPost: true },
          })
        : null,
      leadId ? this.prisma.lead.findUnique({ where: { id: leadId } }) : null,
    ]);

    return { proposal, lead };
  }
}
