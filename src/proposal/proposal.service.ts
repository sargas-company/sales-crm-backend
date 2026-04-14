import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { UpdateProposalDto } from './dto/update-proposal.dto';

@Injectable()
export class ProposalService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateProposalDto, userId: string) {
    if (!dto.title?.trim()) {
      throw new BadRequestException('Title is required');
    }

    return this.prisma.proposal.create({
      data: {
        title: dto.title.trim(),
        vacancy: dto.vacancy,
        comment: dto.comment,
        context: dto.context,
        userId,
      },
    });
  }

  findAll(userId: string) {
    return this.prisma.proposal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const proposal = await this.prisma.proposal.findFirst({
      where: { id, userId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  async update(id: string, dto: UpdateProposalDto, userId: string) {
    if (!dto.title?.trim()) throw new BadRequestException('Title is required');
    await this.findOne(id, userId);
    return this.prisma.proposal.update({
      where: { id },
      data: {
        title: dto.title.trim(),
        vacancy: dto.vacancy,
        comment: dto.comment,
        context: dto.context,
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
