import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import {
  CreateUpworkChangeLogDto,
  ListUpworkChangeLogDto,
  UpdateUpworkChangeLogDto,
} from './dto/upwork-change-log.dto';

const INCLUDE = {
  profile: {
    select: { id: true, firstName: true, lastName: true, title: true },
  },
} as const;

@Injectable()
export class UpworkChangeLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(query: ListUpworkChangeLogDto) {
    const where: Prisma.UpworkChangeLogWhereInput = {};
    if (query.profileId) where.profileId = query.profileId;
    if (query.section) where.section = query.section;
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = new Date(query.from);
      if (query.to) where.date.lte = new Date(query.to);
    }
    return this.prisma.upworkChangeLog.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 500,
      include: INCLUDE,
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.upworkChangeLog.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('change log entry not found');
    return row;
  }

  async create(dto: CreateUpworkChangeLogDto, actorUserId: string) {
    await this.ensureProfile(dto.profileId);
    const row = await this.prisma.upworkChangeLog.create({
      data: {
        date: new Date(dto.date),
        profileId: dto.profileId,
        section: dto.section,
        item: dto.item ?? null,
        summary: dto.summary.trim(),
        reason: dto.reason ?? null,
        before: dto.before ?? '',
        after: dto.after ?? '',
      },
      include: INCLUDE,
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.changelog.create',
      targetType: 'UpworkChangeLog',
      targetId: row.id,
      targetLabel: `${row.section}: ${row.summary.slice(0, 60)}`,
      result: AuditResult.SUCCESS,
      metadata: { profileId: row.profileId },
    });
    return row;
  }

  async update(id: string, dto: UpdateUpworkChangeLogDto, actorUserId: string) {
    const existing = await this.findOne(id);
    if (dto.profileId && dto.profileId !== existing.profileId) {
      await this.ensureProfile(dto.profileId);
    }
    const row = await this.prisma.upworkChangeLog.update({
      where: { id },
      data: {
        ...(dto.date !== undefined ? { date: new Date(dto.date) } : {}),
        ...(dto.profileId !== undefined ? { profileId: dto.profileId } : {}),
        ...(dto.section !== undefined ? { section: dto.section } : {}),
        ...(dto.item !== undefined ? { item: dto.item ?? null } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary.trim() } : {}),
        ...(dto.reason !== undefined ? { reason: dto.reason ?? null } : {}),
        ...(dto.before !== undefined ? { before: dto.before } : {}),
        ...(dto.after !== undefined ? { after: dto.after } : {}),
      },
      include: INCLUDE,
    });

    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.changelog.update',
      targetType: 'UpworkChangeLog',
      targetId: id,
      targetLabel: row.summary.slice(0, 60),
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async remove(id: string, actorUserId: string) {
    const existing = await this.findOne(id);
    await this.prisma.upworkChangeLog.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.changelog.delete',
      targetType: 'UpworkChangeLog',
      targetId: id,
      targetLabel: existing.summary.slice(0, 60),
      result: AuditResult.SUCCESS,
    });
    return { id };
  }

  private async ensureProfile(id: string) {
    const p = await this.prisma.upworkProfile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`profile ${id} not found`);
  }
}
