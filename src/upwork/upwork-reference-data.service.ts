import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import {
  BulkAddUpworkReferenceDataDto,
  BulkDeleteUpworkReferenceDataDto,
  CreateUpworkReferenceDataDto,
  ListUpworkReferenceDataDto,
  UpdateUpworkReferenceDataDto,
} from './dto/upwork-reference-data.dto';

@Injectable()
export class UpworkReferenceDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(query: ListUpworkReferenceDataDto) {
    const where: Prisma.UpworkReferenceDataWhereInput = {};
    if (query.profileId !== undefined) where.profileId = query.profileId;
    if (query.category) where.category = query.category;
    if (query.active !== undefined) where.active = query.active;

    const orderBy: Prisma.UpworkReferenceDataOrderByWithRelationInput[] =
      query.sortByFrequency
        ? [{ frequency: { sort: 'desc', nulls: 'last' } }, { value: 'asc' }]
        : [{ collectedDate: 'desc' }, { value: 'asc' }];

    return this.prisma.upworkReferenceData.findMany({
      where,
      orderBy,
      take: 500,
      include: {
        profile: { select: { id: true, name: true } },
        parent: { select: { id: true, value: true, category: true } },
      },
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.upworkReferenceData.findUnique({
      where: { id },
      include: {
        profile: { select: { id: true, name: true } },
        parent: { select: { id: true, value: true, category: true } },
      },
    });
    if (!row) throw new NotFoundException('reference data entry not found');
    return row;
  }

  async create(dto: CreateUpworkReferenceDataDto, actorUserId: string) {
    if (dto.profileId) await this.ensureProfile(dto.profileId);
    if (dto.parentId) await this.ensureParent(dto.parentId);
    const row = await this.prisma.upworkReferenceData.create({
      data: {
        profileId: dto.profileId ?? null,
        category: dto.category,
        value: dto.value.trim(),
        parentId: dto.parentId ?? null,
        order: dto.order ?? null,
        frequency: dto.frequency ?? null,
        note: dto.note ?? null,
        collectedDate: new Date(dto.collectedDate),
        active: dto.active ?? true,
      },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.reference.create',
      targetType: 'UpworkReferenceData',
      targetId: row.id,
      targetLabel: `${row.category}: ${row.value.slice(0, 60)}`,
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async bulkAdd(dto: BulkAddUpworkReferenceDataDto, actorUserId: string) {
    if (dto.profileId) await this.ensureProfile(dto.profileId);
    const values = dto.values
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) {
      throw new BadRequestException('no non-empty values provided');
    }
    const collectedDate = new Date(dto.collectedDate);
    const data = values.map((value) => ({
      profileId: dto.profileId ?? null,
      category: dto.category,
      value,
      collectedDate,
    }));
    const result = await this.prisma.upworkReferenceData.createMany({ data });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.reference.bulk_add',
      targetType: 'UpworkReferenceData',
      targetId: null,
      targetLabel: `${dto.category} × ${result.count}`,
      result: AuditResult.SUCCESS,
      metadata: {
        count: result.count,
        profileId: dto.profileId ?? null,
        category: dto.category,
      },
    });
    return { added: result.count };
  }

  async update(id: string, dto: UpdateUpworkReferenceDataDto, actorUserId: string) {
    await this.findOne(id);
    if (dto.profileId !== undefined && dto.profileId !== null) {
      await this.ensureProfile(dto.profileId);
    }
    if (dto.parentId !== undefined && dto.parentId !== null) {
      await this.ensureParent(dto.parentId);
    }
    const row = await this.prisma.upworkReferenceData.update({
      where: { id },
      data: {
        ...(dto.profileId !== undefined ? { profileId: dto.profileId ?? null } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.value !== undefined ? { value: dto.value.trim() } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId ?? null } : {}),
        ...(dto.order !== undefined ? { order: dto.order ?? null } : {}),
        ...(dto.frequency !== undefined ? { frequency: dto.frequency ?? null } : {}),
        ...(dto.note !== undefined ? { note: dto.note ?? null } : {}),
        ...(dto.collectedDate !== undefined
          ? { collectedDate: new Date(dto.collectedDate) }
          : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.reference.update',
      targetType: 'UpworkReferenceData',
      targetId: row.id,
      targetLabel: `${row.category}: ${row.value.slice(0, 60)}`,
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async archive(id: string, actorUserId: string) {
    const row = await this.findOne(id);
    const updated = await this.prisma.upworkReferenceData.update({
      where: { id },
      data: { active: false },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.reference.archive',
      targetType: 'UpworkReferenceData',
      targetId: id,
      targetLabel: `${row.category}: ${row.value.slice(0, 60)}`,
      result: AuditResult.SUCCESS,
    });
    return updated;
  }

  async bulkDelete(dto: BulkDeleteUpworkReferenceDataDto, actorUserId: string) {
    if (dto.ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.upworkReferenceData.deleteMany({
      where: { id: { in: dto.ids } },
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.reference.bulk_delete',
      targetType: 'UpworkReferenceData',
      targetId: null,
      targetLabel: `${result.count} entries`,
      result: AuditResult.SUCCESS,
      metadata: { count: result.count },
    });
    return { deleted: result.count };
  }

  private async ensureProfile(id: string) {
    const p = await this.prisma.upworkProfile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`profile ${id} not found`);
  }

  private async ensureParent(id: string) {
    const p = await this.prisma.upworkReferenceData.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`parent reference ${id} not found`);
  }
}
