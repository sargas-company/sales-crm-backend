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
  CreateUpworkKeywordDto,
  UpdateUpworkKeywordDto,
} from './dto/upwork-keyword.dto';
import { normalizeUpworkPhrase } from './upwork.constants';

@Injectable()
export class UpworkKeywordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async listByProfile(profileId: string) {
    await this.ensureProfile(profileId);
    return this.prisma.upworkKeyword.findMany({
      where: { profileId },
      orderBy: [
        { isPrimary: 'desc' },
        { isActive: 'desc' },
        { text: 'asc' },
      ],
    });
  }

  async create(
    profileId: string,
    dto: CreateUpworkKeywordDto,
    actorUserId: string,
  ) {
    await this.ensureProfile(profileId);
    const text = normalizeUpworkPhrase(dto.text);
    if (!text) throw new BadRequestException('keyword text is empty');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (dto.isPrimary) {
          await tx.upworkKeyword.updateMany({
            where: { profileId, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        return tx.upworkKeyword.create({
          data: {
            profileId,
            text,
            isPrimary: !!dto.isPrimary,
          },
        });
      });
      await this.audit.recordSafe({
        actorUserId,
        domain: 'SETTINGS',
        action: 'upwork.keyword.create',
        targetType: 'UpworkKeyword',
        targetId: row.id,
        targetLabel: row.text,
        result: AuditResult.SUCCESS,
      });
      return row;
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `keyword "${text}" already exists for this profile`,
        );
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateUpworkKeywordDto, actorUserId: string) {
    const existing = await this.findOne(id);
    const patch: Prisma.UpworkKeywordUpdateInput = {};
    if (dto.text !== undefined) {
      const text = normalizeUpworkPhrase(dto.text);
      if (!text) throw new BadRequestException('keyword text is empty');
      patch.text = text;
    }
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        if (dto.isPrimary === true && !existing.isPrimary) {
          await tx.upworkKeyword.updateMany({
            where: { profileId: existing.profileId, isPrimary: true },
            data: { isPrimary: false },
          });
          patch.isPrimary = true;
        } else if (dto.isPrimary === false && existing.isPrimary) {
          patch.isPrimary = false;
        }
        return tx.upworkKeyword.update({ where: { id }, data: patch });
      });
      await this.audit.recordSafe({
        actorUserId,
        domain: 'SETTINGS',
        action: 'upwork.keyword.update',
        targetType: 'UpworkKeyword',
        targetId: id,
        targetLabel: row.text,
        result: AuditResult.SUCCESS,
      });
      return row;
    } catch (err: unknown) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'another keyword with the same text already exists for this profile',
        );
      }
      throw err;
    }
  }

  async remove(id: string, actorUserId: string) {
    const existing = await this.findOne(id);
    /* If any snapshot position still references this keyword we
     * cannot hard-delete (FK restrict). Fall back to archive so the
     * historical rank history stays intact but it disappears from
     * the picker. */
    const refs = await this.prisma.upworkMetricsSnapshotPosition.count({
      where: { keywordId: id },
    });
    if (refs > 0) {
      const row = await this.prisma.upworkKeyword.update({
        where: { id },
        data: { isActive: false, isPrimary: false },
      });
      await this.audit.recordSafe({
        actorUserId,
        domain: 'SETTINGS',
        action: 'upwork.keyword.archive',
        targetType: 'UpworkKeyword',
        targetId: id,
        targetLabel: existing.text,
        result: AuditResult.SUCCESS,
      });
      return { id: row.id, archived: true };
    }
    await this.prisma.upworkKeyword.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId,
      domain: 'SETTINGS',
      action: 'upwork.keyword.delete',
      targetType: 'UpworkKeyword',
      targetId: id,
      targetLabel: existing.text,
      result: AuditResult.SUCCESS,
    });
    return { id, archived: false };
  }

  async findOne(id: string) {
    const row = await this.prisma.upworkKeyword.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`keyword ${id} not found`);
    return row;
  }

  private async ensureProfile(id: string) {
    const p = await this.prisma.upworkProfile.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`profile ${id} not found`);
  }
}
