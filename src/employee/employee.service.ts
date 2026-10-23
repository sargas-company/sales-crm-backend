import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditResult, AuditSeverity } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { AVATAR_PRESETS, avatarUrlFor } from '../auth/avatar-presets';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import {
  EmployeeSortBy,
  EmployeeSortDirection,
  ListEmployeesDto,
} from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

/** Removes `compensationRates` from an employee row so callers
 *  without `employees:view_salary` never see the rate. Preserves
 *  everything else. */
const stripSalary = <T extends { compensationRates?: unknown }>(row: T): T => {
  const copy = { ...row };
  delete (copy as { compensationRates?: unknown }).compensationRates;
  return copy;
};

@Injectable()
export class EmployeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateEmployeeDto, actorId: string) {
    try {
      const created = await this.prisma.employee.create({
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          positions: dto.positions && dto.positions.length > 0
            ? { connect: dto.positions.map((id) => ({ id })) }
            : undefined,
          status: dto.status ?? 'ACTIVE',
          terminatedAt: dto.status === 'TERMINATED' ? new Date() : null,
          // Random DiceBear preset from the same catalogue the User
          // picker uses — stamped once at create and never auto-rotated.
          avatarUrl: avatarUrlFor(
            AVATAR_PRESETS[Math.floor(Math.random() * AVATAR_PRESETS.length)],
          ),
          hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : null,
          userId: dto.userId ?? null,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
        },
        include: this.include(),
      });
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'EMPLOYEES',
        action: 'employee.create',
        targetType: 'Employee',
        targetId: created.id,
        targetLabel: `${created.firstName} ${created.lastName}`.trim(),
        targetHref: `/employees/edit/${created.id}`,
        result: AuditResult.SUCCESS,
        metadata: {
          status: created.status,
          email: created.email,
        },
      });
      return created;
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async findAll(
    dto: ListEmployeesDto,
    options: { canViewSalary: boolean } = { canViewSalary: false },
  ) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? EmployeeSortDirection.desc;

    // Birthday-month filter: Prisma has no EXTRACT MONTH operator for
    // native queries, so pre-resolve matching ids with raw SQL and
    // intersect via `where.id IN (...)`. Cost is one extra round-trip
    // only when the filter is applied, which is fine for a directory
    // table of this size.
    let birthdayMonthIds: string[] | null = null;
    if (dto.birthdayMonth !== undefined) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id FROM "Employee"
          WHERE "dateOfBirth" IS NOT NULL
            AND EXTRACT(MONTH FROM "dateOfBirth") = ${dto.birthdayMonth}
        `,
      );
      birthdayMonthIds = rows.map((r) => r.id);
      // Short-circuit: no match → empty result; skip the normal query.
      if (birthdayMonthIds.length === 0) {
        return { data: [], total: 0 };
      }
    }

    /* activeInMonth=YYYY-MM: employees who were active at any point
     * during that calendar month — see DTO docs for the full rule. */
    let activeInMonthWhere: Prisma.EmployeeWhereInput | null = null;
    if (dto.activeInMonth) {
      const [y, m] = dto.activeInMonth.split('-').map(Number);
      const monthStart = new Date(Date.UTC(y, m - 1, 1));
      const monthEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
      activeInMonthWhere = {
        AND: [
          {
            OR: [
              { hiredAt: null },
              { hiredAt: { lte: monthEnd } },
            ],
          },
          {
            OR: [
              { terminatedAt: null },
              { terminatedAt: { gte: monthStart } },
            ],
          },
        ],
      };
    }

    const where: Prisma.EmployeeWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.position
        ? { positions: { some: { id: dto.position } } }
        : {}),
      ...(birthdayMonthIds !== null ? { id: { in: birthdayMonthIds } } : {}),
      ...(activeInMonthWhere ?? {}),
      ...(dto.search
        ? {
            OR: [
              { firstName: { contains: dto.search, mode: 'insensitive' } },
              { lastName: { contains: dto.search, mode: 'insensitive' } },
              { email: { contains: dto.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // Salary sort can't be expressed through Prisma orderBy because
    // it reads from a nested EmployeeCompensationRate row filtered by
    // effectiveDate. For a directory table (<1k rows) the simplest
    // correct path is to fetch all matching rows, normalise HOURLY→
    // monthly in Node, sort, then slice.
    //
    // If the caller lacks `employees:view_salary`, we silently fall
    // through to the default date-based sort instead of 403-ing — the
    // UI shouldn't send `sortBy=salary` for them anyway, this is a
    // defence-in-depth clamp.
    if (dto.sortBy === EmployeeSortBy.salary && options.canViewSalary) {
      const all = await this.prisma.employee.findMany({
        where,
        include: this.include(),
      });
      const normalized = (e: (typeof all)[number]): number => {
        const rate = (e as { compensationRates?: Array<{ rate: unknown; rateType: 'HOURLY' | 'MONTHLY' }> }).compensationRates?.[0];
        if (!rate) return 0;
        const v = Number(rate.rate);
        if (!Number.isFinite(v)) return 0;
        return rate.rateType === 'HOURLY' ? v * 160 : v;
      };
      all.sort((a, b) => {
        const diff = normalized(a) - normalized(b);
        return dir === 'asc' ? diff : -diff;
      });
      return {
        data: all.slice(offset, offset + limit),
        total: all.length,
      };
    }

    const sortBy =
      dto.sortBy === EmployeeSortBy.salary && !options.canViewSalary
        ? undefined
        : dto.sortBy;
    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        orderBy: this.buildOrderBy(sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.employee.count({ where }),
    ]);
    return {
      data: options.canViewSalary ? data : data.map(stripSalary),
      total,
    };
  }

  async findOne(
    id: string,
    options: { canViewSalary: boolean } = { canViewSalary: false },
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return options.canViewSalary ? employee : stripSalary(employee);
  }

  async update(id: string, dto: UpdateEmployeeDto, actorId: string) {
    const existing = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        userId: true,
        hiredAt: true,
      },
    });
    if (!existing) throw new NotFoundException('Employee not found');
    try {
      const updated = await this.prisma.employee.update({
        where: { id },
        data: {
          ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
          ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.positions !== undefined
            ? {
                positions: {
                  set: (dto.positions ?? []).map((id) => ({ id })),
                },
              }
            : {}),
          ...(dto.status !== undefined
            ? {
                status: dto.status,
                // Keep `terminatedAt` in sync with lifecycle: stamp on
                // the ACTIVE/BENCH → TERMINATED edge, clear on the way
                // back. Omit the field entirely when status itself
                // isn't moving to avoid overwriting a prior timestamp
                // on a no-op PATCH.
                terminatedAt:
                  dto.status === 'TERMINATED'
                    ? existing.status === 'TERMINATED'
                      ? undefined
                      : new Date()
                    : null,
              }
            : {}),
          ...(dto.hiredAt !== undefined
            ? { hiredAt: dto.hiredAt ? new Date(dto.hiredAt) : null }
            : {}),
          ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
          ...(dto.dateOfBirth !== undefined
            ? { dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null }
            : {}),
        },
        include: this.include(),
      });
      const changes = safeDiff(
        {
          firstName: existing.firstName,
          lastName: existing.lastName,
          email: existing.email,
          status: existing.status,
          userId: existing.userId,
          hiredAt: existing.hiredAt?.toISOString() ?? null,
        },
        {
          firstName: updated.firstName,
          lastName: updated.lastName,
          email: updated.email,
          status: updated.status,
          userId: updated.userId,
          hiredAt: updated.hiredAt?.toISOString() ?? null,
        },
      );
      const statusChanged = existing.status !== updated.status;
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'EMPLOYEES',
        action: statusChanged ? 'employee.status.change' : 'employee.update',
        targetType: 'Employee',
        targetId: id,
        targetLabel: `${updated.firstName} ${updated.lastName}`.trim(),
        targetHref: `/employees/edit/${id}`,
        result: AuditResult.SUCCESS,
        severity: statusChanged ? AuditSeverity.WARNING : AuditSeverity.INFO,
        changes: changes ?? null,
      });
      return updated;
    } catch (e) {
      throw this.mapWriteError(e);
    }
  }

  async remove(id: string, actorId: string) {
    const existing = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!existing) throw new NotFoundException('Employee not found');
    const deleted = await this.prisma.employee.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'EMPLOYEES',
      action: 'employee.delete',
      targetType: 'Employee',
      targetId: id,
      targetLabel: `${existing.firstName} ${existing.lastName}`.trim(),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
    return deleted;
  }

  private include(): Prisma.EmployeeInclude {
    return {
      user: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
      positions: {
        select: { id: true, title: true, slug: true },
        orderBy: { title: 'asc' },
      },
      /* Current compensation rate = most recent EmployeeCompensationRate
       * whose effectiveDate has already arrived. One row max — the
       * list renders either its {rate, rateType} or 0 if the array is
       * empty. Writes to this table come from the salary-review flow
       * (SalaryReviewResult.INCREASED → auto-inserts a row) as well
       * as any direct compensation CRUD, so this is the single source
       * of truth for "current salary". */
      compensationRates: {
        where: { effectiveDate: { lte: new Date() } },
        orderBy: { effectiveDate: Prisma.SortOrder.desc },
        take: 1,
        select: { rate: true, rateType: true, effectiveDate: true },
      },
    };
  }

  private buildOrderBy(
    sortBy: EmployeeSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.EmployeeOrderByWithRelationInput {
    switch (sortBy) {
      case EmployeeSortBy.firstName:
        return { firstName: dir };
      case EmployeeSortBy.lastName:
        return { lastName: dir };
      case EmployeeSortBy.email:
        return { email: dir };
      case EmployeeSortBy.status:
        return { status: dir };
      case EmployeeSortBy.hiredAt:
        return { hiredAt: dir };
      case EmployeeSortBy.updatedAt:
        return { updatedAt: dir };
      case EmployeeSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  private async assertExists(id: string) {
    const found = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Employee not found');
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        const target = Array.isArray(e.meta?.target)
          ? (e.meta?.target as string[]).join(', ')
          : String(e.meta?.target ?? '');
        if (target.includes('email')) {
          return new ConflictException('Employee with this email already exists');
        }
        if (target.includes('userId')) {
          return new ConflictException('This user is already linked to another employee');
        }
        return new ConflictException('Employee constraint violation');
      }
      if (e.code === 'P2003') {
        return new BadRequestException('Related record not found');
      }
    }
    return e as Error;
  }
}
