import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditResult } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import {
  CreateUpworkProfileDto,
  UpdateUpworkProfileDto,
} from './dto/upwork-profile.dto';

@Injectable()
export class UpworkProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  list() {
    return this.prisma.upworkProfile.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.upworkProfile.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('upwork profile not found');
    return row;
  }

  async create(dto: CreateUpworkProfileDto, actorUserId: string) {
    const row = await this.prisma.upworkProfile.create({
      data: {
        name: dto.name.trim(),
        url: dto.url ?? null,
        note: dto.note ?? null,
        active: dto.active ?? true,
      },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.profile.create',
      targetType: 'UpworkProfile',
      targetId: row.id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async update(id: string, dto: UpdateUpworkProfileDto, actorUserId: string) {
    await this.findOne(id);
    const row = await this.prisma.upworkProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.url !== undefined ? { url: dto.url ?? null } : {}),
        ...(dto.note !== undefined ? { note: dto.note ?? null } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.profile.update',
      targetType: 'UpworkProfile',
      targetId: row.id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async remove(id: string, actorUserId: string) {
    const row = await this.findOne(id);
    await this.prisma.upworkProfile.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.profile.delete',
      targetType: 'UpworkProfile',
      targetId: id,
      targetLabel: row.name,
      result: AuditResult.SUCCESS,
    });
    return { id };
  }
}
