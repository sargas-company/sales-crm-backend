import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import {
  CreateUpworkSnapshotDto,
  ListUpworkSnapshotsDto,
  SnapshotPositionDto,
  UpdateUpworkSnapshotDto,
} from './dto/upwork-metrics.dto';

const INCLUDE = {
  positions: {
    include: {
      referenceData: {
        select: { id: true, value: true, category: true, profileId: true },
      },
    },
  },
} as const;

@Injectable()
export class UpworkMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(query: ListUpworkSnapshotsDto) {
    const where: Prisma.UpworkMetricsSnapshotWhereInput = {
      profileId: query.profileId,
    };
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = new Date(query.from);
      if (query.to) where.date.lte = new Date(query.to);
    }
    return this.prisma.upworkMetricsSnapshot.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 500,
      include: INCLUDE,
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.upworkMetricsSnapshot.findUnique({
      where: { id },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('snapshot not found');
    return row;
  }

  async create(dto: CreateUpworkSnapshotDto, actorUserId: string) {
    await this.ensureProfile(dto.profileId);
    const positions = dto.positions ?? [];
    if (positions.length) await this.validatePositions(positions, dto.profileId);
    const date = new Date(dto.date);
    try {
      const row = await this.prisma.upworkMetricsSnapshot.create({
        data: {
          date,
          profileId: dto.profileId,
          views: dto.views,
          invites: dto.invites,
          directMessages: dto.directMessages,
          positions: positions.length
            ? {
                create: positions.map((p) => ({
                  referenceDataId: p.referenceDataId,
                  position: p.position,
                })),
              }
            : undefined,
        },
        include: INCLUDE,
      });
      await this.audit.recordSafe({
        actorUserId,
        domain: 'SETTINGS',
        action: 'upwork.snapshot.create',
        targetType: 'UpworkMetricsSnapshot',
        targetId: row.id,
        targetLabel: `${row.date.toISOString().slice(0, 10)}`,
        result: AuditResult.SUCCESS,
      });
      return row;
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'a snapshot already exists for this profile and date',
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateUpworkSnapshotDto, actorUserId: string) {
    const existing = await this.findOne(id);
    if (dto.profileId && dto.profileId !== existing.profileId) {
      await this.ensureProfile(dto.profileId);
    }
    const nextProfileId = dto.profileId ?? existing.profileId;
    const positions = dto.positions;
    if (positions && positions.length) {
      await this.validatePositions(positions, nextProfileId);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.upworkMetricsSnapshot.update({
        where: { id },
        data: {
          ...(dto.date !== undefined ? { date: new Date(dto.date) } : {}),
          ...(dto.profileId !== undefined ? { profileId: dto.profileId } : {}),
          ...(dto.views !== undefined ? { views: dto.views } : {}),
          ...(dto.invites !== undefined ? { invites: dto.invites } : {}),
          ...(dto.directMessages !== undefined
            ? { directMessages: dto.directMessages }
            : {}),
        },
      });
      if (positions) {
        await tx.upworkMetricsSnapshotPosition.deleteMany({
          where: { snapshotId: id },
        });
        if (positions.length) {
          await tx.upworkMetricsSnapshotPosition.createMany({
            data: positions.map((p) => ({
              snapshotId: id,
              referenceDataId: p.referenceDataId,
              position: p.position,
            })),
          });
        }
      }
      return tx.upworkMetricsSnapshot.findUnique({
        where: { id: updated.id },
        include: INCLUDE,
      });
    });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.snapshot.update',
      targetType: 'UpworkMetricsSnapshot',
      targetId: id,
      result: AuditResult.SUCCESS,
    });
    return row;
  }

  async remove(id: string, actorUserId: string) {
    await this.findOne(id);
    await this.prisma.upworkMetricsSnapshot.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.snapshot.delete',
      targetType: 'UpworkMetricsSnapshot',
      targetId: id,
      result: AuditResult.SUCCESS,
    });
    return { id };
  }

  private async ensureProfile(id: string) {
    const p = await this.prisma.upworkProfile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`profile ${id} not found`);
  }

  /** Positions must reference title_phrase entries that belong to this
   *  profile or are shared (profileId = null). */
  private async validatePositions(
    positions: SnapshotPositionDto[],
    profileId: string,
  ) {
    const ids = positions.map((p) => p.referenceDataId);
    const rows = await this.prisma.upworkReferenceData.findMany({
      where: { id: { in: ids } },
      select: { id: true, profileId: true, category: true },
    });
    if (rows.length !== ids.length) {
      throw new NotFoundException('one or more reference entries not found');
    }
    const bad = rows.find(
      (r) =>
        r.category !== 'title_phrase' ||
        (r.profileId !== null && r.profileId !== profileId),
    );
    if (bad) {
      throw new BadRequestException(
        'positions may only reference title_phrase entries from this profile (or shared)',
      );
    }
  }
}
