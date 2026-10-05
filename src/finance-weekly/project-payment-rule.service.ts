import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UpsertPaymentRuleDto } from './dto/upsert-payment-rule.dto';

@Injectable()
export class ProjectPaymentRuleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    return this.prisma.projectPaymentRule.findMany({
      where: { projectId },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async currentForProject(projectId: string, asOf: Date = new Date()) {
    return this.prisma.projectPaymentRule.findFirst({
      where: { projectId, effectiveFrom: { lte: asOf } },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async createOrReplace(projectId: string, dto: UpsertPaymentRuleDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const effectiveFrom = dto.effectiveFrom
      ? new Date(dto.effectiveFrom)
      : new Date();
    effectiveFrom.setUTCHours(0, 0, 0, 0);

    return this.prisma.projectPaymentRule.create({
      data: {
        projectId,
        type: dto.type,
        delayDays: dto.delayDays ?? null,
        dayOfWeek: dto.dayOfWeek ?? null,
        intervalWeeks: dto.intervalWeeks ?? null,
        note: dto.note ?? null,
        effectiveFrom,
      },
    });
  }
}
