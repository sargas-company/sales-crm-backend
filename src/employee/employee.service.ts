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
import { CreateEmployeeDto } from './dto/create-employee.dto';
import {
  EmployeeSortBy,
  EmployeeSortDirection,
  ListEmployeesDto,
} from './dto/list-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

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
          positions: dto.positions ?? [],
          status: dto.status ?? 'active',
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

  async findAll(dto: ListEmployeesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? EmployeeSortDirection.desc;

    const where: Prisma.EmployeeWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
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

    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.employee.count({ where }),
    ]);
    return { data, total };
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: this.include(),
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
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
            ? { positions: dto.positions ?? [] }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
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
