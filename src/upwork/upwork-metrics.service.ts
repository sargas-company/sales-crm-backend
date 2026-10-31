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
import { normalizeUpworkPhrase } from './upwork.constants';

const INCLUDE = {
  positions: {
    select: { id: true, phrase: true, position: true },
    orderBy: { position: 'asc' } as const,
  },
} as const;

interface NormalizedPosition {
  phrase: string;
  position: number;
}

@Injectable()
export class UpworkMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async list(query: ListUpworkSnapshotsDto) {
    const where: Prisma.UpworkMetricsSnapshotWhereInput = {};
    if (query.profileId) where.profileId = query.profileId;
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
    const positions = this.normalizePositions(dto.positions ?? []);
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
            ? { create: positions }
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
    const positions = dto.positions
      ? this.normalizePositions(dto.positions)
      : undefined;
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
              phrase: p.phrase,
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

  /** Normalize phrases (lower + collapse ws + trim) and reject
   *  duplicates within the same payload. */
  private normalizePositions(
    positions: SnapshotPositionDto[],
  ): NormalizedPosition[] {
    const seen = new Set<string>();
    const out: NormalizedPosition[] = [];
    for (const p of positions) {
      const phrase = normalizeUpworkPhrase(p.phrase);
      if (!phrase) {
        throw new BadRequestException('position phrase cannot be empty');
      }
      if (seen.has(phrase)) {
        throw new BadRequestException(
          `duplicate phrase in payload: "${phrase}"`,
        );
      }
      seen.add(phrase);
      out.push({ phrase, position: p.position });
    }
    return out;
  }
}
