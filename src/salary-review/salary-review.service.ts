import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  Prisma,
  SalaryReviewResult,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { CreateSalaryReviewDto } from './dto/create-salary-review.dto';
import {
  ListSalaryReviewsDto,
  SalaryReviewSortBy,
  SalaryReviewSortDirection,
  SalaryReviewStatus,
} from './dto/list-salary-reviews.dto';
import { UpdateSalaryReviewDto } from './dto/update-salary-review.dto';

const { Decimal } = Prisma;

@Injectable()
export class SalaryReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async findAll(dto: ListSalaryReviewsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      (dto.sortDirection as Prisma.SortOrder | undefined) ??
      SalaryReviewSortDirection.desc;

    const today = this.today();
    const statusFilter = dto.status
      ? this.statusWhere(dto.status, today)
      : {};

    const where: Prisma.SalaryReviewWhereInput = {
      AND: [
        dto.employeeId ? { employeeId: dto.employeeId } : {},
        dto.result ? { result: dto.result } : {},
        dto.year
          ? {
              OR: [
                {
                  scheduledDate: {
                    gte: new Date(Date.UTC(dto.year, 0, 1)),
                    lte: new Date(Date.UTC(dto.year, 11, 31)),
                  },
                },
                {
                  effectiveDate: {
                    gte: new Date(Date.UTC(dto.year, 0, 1)),
                    lte: new Date(Date.UTC(dto.year, 11, 31)),
                  },
                },
              ],
            }
          : {},
        dto.from ? { scheduledDate: { gte: this.parseDay(dto.from) } } : {},
        dto.to ? { scheduledDate: { lte: this.parseDay(dto.to) } } : {},
        dto.search
          ? {
              OR: [
                {
                  employee: {
                    firstName: { contains: dto.search, mode: 'insensitive' },
                  },
                },
                {
                  employee: {
                    lastName: { contains: dto.search, mode: 'insensitive' },
                  },
                },
                { note: { contains: dto.search, mode: 'insensitive' } },
              ],
            }
          : {},
        statusFilter,
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.salaryReview.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.salaryReview.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(id: string) {
    const row = await this.prisma.salaryReview.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!row) throw new NotFoundException('Salary review not found');
    return row;
  }

  async create(dto: CreateSalaryReviewDto, actorId: string) {
    await this.assertEmployeeExists(dto.employeeId);
    this.validateResult(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.salaryReview.create({
        data: {
          employeeId: dto.employeeId,
          scheduledDate: this.parseDay(dto.scheduledDate),
          previousRateType: dto.previousRateType,
          previousRate:
            dto.previousRate != null ? new Decimal(dto.previousRate) : null,
          newRateType: dto.newRateType,
          newRate: dto.newRate != null ? new Decimal(dto.newRate) : null,
          effectiveDate: dto.effectiveDate
            ? this.parseDay(dto.effectiveDate)
            : null,
          result: dto.result ?? null,
          note: dto.note,
          completedAt:
            dto.result && dto.result !== 'POSTPONED' ? new Date() : null,
        },
      });

      if (
        row.result === 'INCREASED' &&
        row.newRateType &&
        row.newRate &&
        row.effectiveDate
      ) {
        await tx.employeeCompensationRate.create({
          data: {
            employeeId: row.employeeId,
            rateType: row.newRateType,
            rate: row.newRate,
            effectiveDate: row.effectiveDate,
            note: `Salary review ${row.id}`,
          },
        });
      }
      return row;
    });

    const full = await this.findOne(created.id);
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'salaryReview.create',
      targetType: 'SalaryReview',
      targetId: created.id,
      targetLabel: `${full.employee?.firstName ?? ''} ${full.employee?.lastName ?? ''}`.trim(),
      result: AuditResult.SUCCESS,
      metadata: {
        scheduledDate: full.scheduledDate?.toISOString() ?? null,
        result: full.result,
      },
    });
    return full;
  }

  async update(id: string, dto: UpdateSalaryReviewDto, actorId: string) {
    const existing = await this.prisma.salaryReview.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Salary review not found');

    const nextResult = dto.result ?? existing.result;
    const nextEffective = dto.effectiveDate
      ? this.parseDay(dto.effectiveDate)
      : dto.effectiveDate === null
        ? null
        : existing.effectiveDate;
    const nextNewRate =
      dto.newRate != null ? new Decimal(dto.newRate) : existing.newRate;
    const nextNewRateType =
      dto.newRateType != null ? dto.newRateType : existing.newRateType;

    if (
      nextResult === 'INCREASED' &&
      (!nextEffective || !nextNewRate || !nextNewRateType)
    ) {
      throw new BadRequestException(
        'INCREASED result requires effectiveDate, newRateType and newRate',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.salaryReview.update({
        where: { id },
        data: {
          ...(dto.scheduledDate
            ? { scheduledDate: this.parseDay(dto.scheduledDate) }
            : {}),
          ...(dto.previousRateType !== undefined
            ? { previousRateType: dto.previousRateType }
            : {}),
          ...(dto.previousRate !== undefined
            ? {
                previousRate:
                  dto.previousRate != null ? new Decimal(dto.previousRate) : null,
              }
            : {}),
          ...(dto.newRateType !== undefined ? { newRateType: dto.newRateType } : {}),
          ...(dto.newRate !== undefined
            ? { newRate: dto.newRate != null ? new Decimal(dto.newRate) : null }
            : {}),
          ...(dto.effectiveDate !== undefined
            ? {
                effectiveDate: dto.effectiveDate
                  ? this.parseDay(dto.effectiveDate)
                  : null,
              }
            : {}),
          ...(dto.result !== undefined
            ? {
                result: dto.result,
                completedAt:
                  dto.result && dto.result !== 'POSTPONED'
                    ? (existing.completedAt ?? new Date())
                    : null,
              }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });

      // Rewire effective compensation rate when the review flips to
      // INCREASED (either just now or already was and its rate changed).
      const shouldMaterialize =
        nextResult === 'INCREASED' &&
        nextEffective &&
        nextNewRate &&
        nextNewRateType;

      if (shouldMaterialize) {
        await tx.employeeCompensationRate.deleteMany({
          where: { note: `Salary review ${id}` },
        });
        await tx.employeeCompensationRate.create({
          data: {
            employeeId: existing.employeeId,
            rateType: nextNewRateType!,
            rate: nextNewRate!,
            effectiveDate: nextEffective!,
            note: `Salary review ${id}`,
          },
        });
      } else {
        // Result changed away from INCREASED — retract the rate row.
        await tx.employeeCompensationRate.deleteMany({
          where: { note: `Salary review ${id}` },
        });
      }
    });

    const updated = await this.findOne(id);
    const changes = safeDiff(
      {
        result: existing.result,
        newRate: existing.newRate?.toString() ?? null,
        effectiveDate: existing.effectiveDate?.toISOString() ?? null,
      },
      {
        result: updated.result,
        newRate: updated.newRate?.toString() ?? null,
        effectiveDate: updated.effectiveDate?.toISOString() ?? null,
      },
    );
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: existing.result !== updated.result
        ? 'salaryReview.result.change'
        : 'salaryReview.update',
      targetType: 'SalaryReview',
      targetId: id,
      targetLabel:
        `${updated.employee?.firstName ?? ''} ${updated.employee?.lastName ?? ''}`.trim(),
      result: AuditResult.SUCCESS,
      severity:
        existing.result !== updated.result
          ? AuditSeverity.WARNING
          : AuditSeverity.INFO,
      changes: changes ?? null,
    });
    return updated;
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.salaryReview.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!existing) throw new NotFoundException('Salary review not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.employeeCompensationRate.deleteMany({
        where: { note: `Salary review ${id}` },
      });
      await tx.salaryReview.delete({ where: { id } });
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'salaryReview.delete',
      targetType: 'SalaryReview',
      targetId: id,
      targetLabel:
        `${existing.employee?.firstName ?? ''} ${existing.employee?.lastName ?? ''}`.trim(),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private include(): Prisma.SalaryReviewInclude {
    return {
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          status: true,
          positions: true,
        },
      },
    };
  }

  private validateResult(dto: CreateSalaryReviewDto) {
    if (
      dto.result === 'INCREASED' &&
      (!dto.effectiveDate || dto.newRate == null || !dto.newRateType)
    ) {
      throw new BadRequestException(
        'INCREASED result requires effectiveDate, newRateType and newRate',
      );
    }
  }

  private statusWhere(
    status: SalaryReviewStatus,
    today: Date,
  ): Prisma.SalaryReviewWhereInput {
    switch (status) {
      case SalaryReviewStatus.upcoming:
        return {
          result: null,
          scheduledDate: { gte: today },
        };
      case SalaryReviewStatus.postponed:
        return { result: 'POSTPONED' };
      case SalaryReviewStatus.completed:
        return { result: { in: ['INCREASED', 'NO_CHANGE'] as SalaryReviewResult[] } };
    }
  }

  private buildOrderBy(
    sortBy: SalaryReviewSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.SalaryReviewOrderByWithRelationInput[] {
    switch (sortBy) {
      case SalaryReviewSortBy.effectiveDate:
        return [{ effectiveDate: dir }, { scheduledDate: dir }];
      case SalaryReviewSortBy.createdAt:
        return [{ createdAt: dir }];
      case SalaryReviewSortBy.result:
        return [{ result: dir }, { scheduledDate: 'desc' }];
      case SalaryReviewSortBy.employee:
        return [
          { employee: { firstName: dir } },
          { employee: { lastName: dir } },
        ];
      case SalaryReviewSortBy.previousRate:
        return [{ previousRate: dir }];
      case SalaryReviewSortBy.newRate:
        return [{ newRate: dir }];
      case SalaryReviewSortBy.scheduledDate:
      default:
        return [{ scheduledDate: dir }];
    }
  }

  private parseDay(iso: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) throw new BadRequestException(`Invalid date: ${iso}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  private today(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async assertEmployeeExists(employeeId: string): Promise<void> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!emp) throw new BadRequestException('Employee not found');
  }
}
