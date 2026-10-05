import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser, scopePolicy } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { CreateProjectDto } from './dto/create-project.dto';
import {
  ListProjectsDto,
  ProjectSortBy,
  ProjectSortDirection,
} from './dto/list-projects.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AuditResult, AuditSeverity } from '@prisma/client';

@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateProjectDto, user: AuthUser) {
    this.assertDateRangeValid(dto.startDate, dto.endDate);
    if (dto.clientId) {
      await this.assertClientExists(dto.clientId);
    }
    if (dto.memberIds && dto.memberIds.length > 0) {
      await this.assertEmployeesExist(dto.memberIds);
    }
    let created;
    try {
      created = await this.prisma.project.create({
        data: {
          name: dto.name,
          clientId: dto.clientId ?? null,
          status: dto.status ?? 'planned',
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          discordChannelId: dto.discordChannelId ?? null,
          ...(dto.memberIds && dto.memberIds.length > 0
            ? {
                members: {
                  create: dto.memberIds.map((employeeId) => ({ employeeId })),
                },
              }
            : {}),
        },
        include: this.include(),
      });
    } catch (e) {
      throw this.mapWriteError(e);
    }
    // Seed the status audit trail with the initial value.
    await this.prisma.projectStatusHistory.create({
      data: {
        projectId: created.id,
        status: created.status,
        effectiveAt: created.createdAt,
      },
    });
    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: 'PROJECTS',
      action: 'project.create',
      targetType: 'Project',
      targetId: created.id,
      targetLabel: created.name,
      targetHref: `/projects/edit/${created.id}`,
      result: AuditResult.SUCCESS,
      metadata: {
        status: created.status,
        memberCount: dto.memberIds?.length ?? 0,
      },
    });
    return created;
  }

  async findAll(dto: ListProjectsDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? ProjectSortDirection.desc;

    const scopeWhere = await this.buildScopeWhere(user);

    const where: Prisma.ProjectWhereInput = {
      AND: [
        scopeWhere,
        dto.status ? { status: dto.status } : {},
        dto.clientId ? { clientId: dto.clientId } : {},
        dto.search
          ? { name: { contains: dto.search, mode: 'insensitive' } }
          : {},
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        orderBy: this.buildOrderBy(dto.sortBy, dir),
        skip: offset,
        take: limit,
        include: this.include(),
      }),
      this.prisma.project.count({ where }),
    ]);
    return { data, total };
  }

  async findOne(id: string, user: AuthUser) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        ...this.include(),
        reports: {
          orderBy: [{ reportDate: 'desc' }, { createdAt: 'desc' }],
          take: 10,
          include: {
            employee: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertCanAccessProject(project.id, user);
    return project;
  }

  async update(id: string, dto: UpdateProjectDto, user: AuthUser) {
    await this.assertExists(id);
    await this.assertCanAccessProject(id, user);
    if (dto.clientId !== undefined && dto.clientId !== null) {
      await this.assertClientExists(dto.clientId);
    }
    if (dto.memberIds !== undefined) {
      await this.assertEmployeesExist(dto.memberIds ?? []);
    }
    const beforeFull = await this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: { members: { select: { employeeId: true } } },
    });
    // Validate the resulting start/end range: if the caller passed
    // only one bound, compare against the existing other one.
    const nextStartIso =
      dto.startDate !== undefined
        ? dto.startDate
        : beforeFull.startDate?.toISOString();
    const nextEndIso =
      dto.endDate !== undefined
        ? dto.endDate
        : beforeFull.endDate?.toISOString();
    this.assertDateRangeValid(nextStartIso ?? undefined, nextEndIso ?? undefined);
    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
      // Read the current status so we only log a real transition.
      const before = await tx.project.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      await tx.project.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.clientId !== undefined ? { clientId: dto.clientId } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.startDate !== undefined
            ? { startDate: dto.startDate ? new Date(dto.startDate) : null }
            : {}),
          ...(dto.endDate !== undefined
            ? { endDate: dto.endDate ? new Date(dto.endDate) : null }
            : {}),
          ...(dto.discordChannelId !== undefined
            ? { discordChannelId: dto.discordChannelId }
            : {}),
        },
      });
      if (dto.status !== undefined && dto.status !== before.status) {
        await tx.projectStatusHistory.create({
          data: {
            projectId: id,
            status: dto.status,
            effectiveAt: new Date(),
          },
        });
      }
      if (dto.memberIds !== undefined) {
        await tx.projectMember.deleteMany({ where: { projectId: id } });
        if (dto.memberIds.length > 0) {
          await tx.projectMember.createMany({
            data: dto.memberIds.map((employeeId) => ({
              projectId: id,
              employeeId,
            })),
            skipDuplicates: true,
          });
        }
      }
      return tx.project.findUniqueOrThrow({
        where: { id },
        include: this.include(),
      });
    });
    } catch (e) {
      throw this.mapWriteError(e);
    }

    // Audit — status changes + membership diff.
    const changes = safeDiff(
      {
        name: beforeFull.name,
        status: beforeFull.status,
        clientId: beforeFull.clientId,
        startDate: beforeFull.startDate?.toISOString() ?? null,
        endDate: beforeFull.endDate?.toISOString() ?? null,
      },
      {
        name: updated.name,
        status: updated.status,
        clientId: updated.clientId,
        startDate: updated.startDate?.toISOString() ?? null,
        endDate: updated.endDate?.toISOString() ?? null,
      },
    );
    const beforeMembers = beforeFull.members.map((m) => m.employeeId);
    const afterMembers = (updated as unknown as {
      members?: Array<{ employeeId: string }>;
    }).members?.map((m) => m.employeeId) ?? beforeMembers;
    const bs = new Set(beforeMembers);
    const as_ = new Set(afterMembers);
    const added = afterMembers.filter((e) => !bs.has(e));
    const removed = beforeMembers.filter((e) => !as_.has(e));
    const membersDiff =
      added.length || removed.length ? { added, removed } : undefined;

    const action =
      beforeFull.status !== updated.status
        ? 'project.status.change'
        : membersDiff
          ? 'project.members.change'
          : 'project.update';
    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: 'PROJECTS',
      action,
      targetType: 'Project',
      targetId: id,
      targetLabel: updated.name,
      targetHref: `/projects/edit/${id}`,
      result: AuditResult.SUCCESS,
      changes: changes ?? null,
      metadata: membersDiff ? { members: membersDiff } : undefined,
    });
    return updated;
  }

  async remove(id: string, user: AuthUser) {
    const existing = await this.prisma.project.findUniqueOrThrow({
      where: { id },
      select: { name: true },
    });
    await this.assertCanAccessProject(id, user);
    await this.prisma.project.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: 'PROJECTS',
      action: 'project.delete',
      targetType: 'Project',
      targetId: id,
      targetLabel: existing.name,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private include(): Prisma.ProjectInclude {
    return {
      client: {
        select: { id: true, firstName: true, lastName: true, type: true },
      },
      members: {
        include: {
          employee: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              positions: true,
              status: true,
            },
          },
        },
      },
    };
  }

  private buildOrderBy(
    sortBy: ProjectSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.ProjectOrderByWithRelationInput {
    switch (sortBy) {
      case ProjectSortBy.name:
        return { name: dir };
      case ProjectSortBy.status:
        return { status: dir };
      case ProjectSortBy.startDate:
        return { startDate: dir };
      case ProjectSortBy.endDate:
        return { endDate: dir };
      case ProjectSortBy.updatedAt:
        return { updatedAt: dir };
      case ProjectSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  private async buildScopeWhere(
    user: AuthUser,
  ): Promise<Prisma.ProjectWhereInput> {
    if (scopePolicy.canViewAnyProject(user)) return {};
    // Scope reads to projects the caller is on. If they have no linked
    // Employee, they see nothing.
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!employee) return { id: { in: [] } };
    return { members: { some: { employeeId: employee.id } } };
  }

  private async assertCanAccessProject(
    projectId: string,
    user: AuthUser,
  ): Promise<void> {
    if (scopePolicy.canViewAnyProject(user)) return;
    const employee = await this.prisma.employee.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Project not found');
    const membership = await this.prisma.projectMember.findUnique({
      where: {
        projectId_employeeId: { projectId, employeeId: employee.id },
      },
      select: { projectId: true },
    });
    if (!membership) throw new ForbiddenException('PROJECT_ACCESS_DENIED');
  }

  private async assertExists(id: string) {
    const found = await this.prisma.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Project not found');
  }

  /**
   * Reject payloads where `startDate` lands after `endDate`. The DTO
   * accepts either in isolation; the pair is only meaningful when both
   * are set.
   */
  private assertDateRangeValid(startIso?: string, endIso?: string) {
    if (!startIso || !endIso) return;
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    if (start > end) {
      throw new BadRequestException('startDate must be on or before endDate');
    }
  }

  private async assertClientExists(id: string) {
    const client = await this.prisma.counterparty.findUnique({
      where: { id },
      select: { id: true, type: true },
    });
    if (!client) throw new BadRequestException('Client counterparty not found');
    if (client.type !== 'client') {
      throw new BadRequestException(
        'Only client-type counterparties can be linked to a project',
      );
    }
  }

  private async assertEmployeesExist(ids: string[]) {
    if (ids.length === 0) return;
    const unique = Array.from(new Set(ids));
    const found = await this.prisma.employee.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      throw new BadRequestException('One or more employees not found');
    }
  }

  private mapWriteError(e: unknown): Error {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') {
        const target = Array.isArray(e.meta?.target)
          ? (e.meta?.target as string[]).join(', ')
          : String(e.meta?.target ?? '');
        if (target.includes('discordChannelId')) {
          return new ConflictException(
            'This Discord channel is already linked to another project',
          );
        }
        return new ConflictException('Project constraint violation');
      }
      if (e.code === 'P2003') {
        return new BadRequestException('Related record not found');
      }
    }
    return e as Error;
  }
}
