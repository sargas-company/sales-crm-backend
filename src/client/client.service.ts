import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  Client,
  ClientStatus,
  Prisma,
} from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientDto } from './dto/create-client.dto';
import {
  ClientSortBy,
  ClientSortDirection,
  ListClientsDto,
} from './dto/list-clients.dto';
import { UpdateClientDto } from './dto/update-client.dto';

const DOMAIN = 'clients';
const TARGET_TYPE = 'Client';

const label = (c: Pick<Client, 'firstName' | 'lastName' | 'company'>): string =>
  [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
  c.company ||
  'client';

@Injectable()
export class ClientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateClientDto, user: AuthUser) {
    const created = await this.prisma.client.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        company: dto.company ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        source: dto.source ?? null,
        profileUrl: dto.profileUrl ?? null,
        status: dto.status ?? ClientStatus.ACTIVE,
        clientSince: dto.clientSince ? new Date(dto.clientSince) : null,
        notes: dto.notes ?? null,
      },
    });

    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: DOMAIN,
      action: 'client.create',
      targetType: TARGET_TYPE,
      targetId: created.id,
      targetLabel: label(created),
      targetHref: `/clients/${created.id}`,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.INFO,
      metadata: {
        status: created.status,
        hasLastName: created.lastName !== null,
        hasCompany: created.company !== null,
        hasEmail: created.email !== null,
        hasPhone: created.phone !== null,
        source: created.source,
      },
    });

    return created;
  }

  async findAll(dto: ListClientsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? ClientSortDirection.desc;

    const where: Prisma.ClientWhereInput = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.source ? { source: dto.source } : {}),
      ...(dto.clientSinceFrom || dto.clientSinceTo
        ? {
            clientSince: {
              ...(dto.clientSinceFrom
                ? { gte: new Date(dto.clientSinceFrom) }
                : {}),
              ...(dto.clientSinceTo
                ? { lte: new Date(dto.clientSinceTo) }
                : {}),
            },
          }
        : {}),
      ...(dto.search
        ? {
            OR: [
              { firstName: { contains: dto.search, mode: 'insensitive' } },
              { lastName: { contains: dto.search, mode: 'insensitive' } },
              { company: { contains: dto.search, mode: 'insensitive' } },
              { email: { contains: dto.search, mode: 'insensitive' } },
              { phone: { contains: dto.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: string): Promise<Client> {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  async update(id: string, dto: UpdateClientDto, user: AuthUser) {
    const existing = await this.prisma.client.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Client not found');

    const data: Prisma.ClientUpdateInput = {
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(dto.company !== undefined ? { company: dto.company } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      ...(dto.source !== undefined ? { source: dto.source } : {}),
      ...(dto.profileUrl !== undefined ? { profileUrl: dto.profileUrl } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.clientSince !== undefined
        ? {
            clientSince: dto.clientSince ? new Date(dto.clientSince) : null,
          }
        : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };

    const updated = await this.prisma.client.update({
      where: { id },
      data,
    });

    const statusChanged =
      dto.status !== undefined && dto.status !== existing.status;
    const noteChanged =
      dto.notes !== undefined && (dto.notes ?? null) !== existing.notes;
    const contactChanged =
      (dto.email !== undefined && (dto.email ?? null) !== existing.email) ||
      (dto.phone !== undefined && (dto.phone ?? null) !== existing.phone);

    if (statusChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'client.status_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/clients/${id}`,
        result: AuditResult.SUCCESS,
        changes: {
          status: { before: existing.status, after: updated.status },
        },
      });
    }
    if (noteChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'client.note_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/clients/${id}`,
        result: AuditResult.SUCCESS,
        changes: { notes: { changed: true } },
      });
    }
    if (contactChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'client.contact_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/clients/${id}`,
        result: AuditResult.SUCCESS,
        changes: {
          ...(dto.email !== undefined && (dto.email ?? null) !== existing.email
            ? { email: { changed: true } }
            : {}),
          ...(dto.phone !== undefined && (dto.phone ?? null) !== existing.phone
            ? { phone: { changed: true } }
            : {}),
        },
      });
    }
    if (!statusChanged && !noteChanged && !contactChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'client.update',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/clients/${id}`,
        result: AuditResult.SUCCESS,
      });
    }

    return updated;
  }

  async remove(id: string, user: AuthUser) {
    const existing = await this.prisma.client.findUnique({
      where: { id },
      include: { _count: { select: { projects: true } } },
    });
    if (!existing) throw new NotFoundException('Client not found');
    if (existing._count.projects > 0) {
      throw new ConflictException({
        message:
          'Client is linked to one or more projects. Reassign or archive those projects first.',
        projectCount: existing._count.projects,
      });
    }

    await this.prisma.client.delete({ where: { id } });

    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: DOMAIN,
      action: 'client.delete',
      targetType: TARGET_TYPE,
      targetId: id,
      targetLabel: label(existing),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  /**
   * Non-blocking duplicate hint for the create/edit UI. Looks up by
   * normalised email OR normalised phone; empty inputs return no
   * suggestions. The service never auto-merges or links.
   */
  async findDuplicates(opts: { email?: string | null; phone?: string | null; excludeId?: string }) {
    if (!opts.email && !opts.phone) return [];
    const or: Prisma.ClientWhereInput[] = [];
    if (opts.email) or.push({ email: opts.email.toLowerCase() });
    if (opts.phone) or.push({ phone: opts.phone });
    const matches = await this.prisma.client.findMany({
      where: {
        AND: [
          { OR: or },
          opts.excludeId ? { NOT: { id: opts.excludeId } } : {},
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        company: true,
        email: true,
        phone: true,
        status: true,
      },
      take: 10,
    });
    return matches;
  }

  private buildOrderBy(
    sortBy: ClientSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.ClientOrderByWithRelationInput {
    switch (sortBy) {
      case ClientSortBy.firstName:
        return { firstName: dir };
      case ClientSortBy.company:
        return { company: { sort: dir, nulls: 'last' } };
      case ClientSortBy.email:
        return { email: { sort: dir, nulls: 'last' } };
      case ClientSortBy.phone:
        return { phone: { sort: dir, nulls: 'last' } };
      case ClientSortBy.status:
        return { status: dir };
      case ClientSortBy.clientSince:
        return { clientSince: { sort: dir, nulls: 'last' } };
      case ClientSortBy.updatedAt:
        return { updatedAt: dir };
      case ClientSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async activity(id: string) {
    const exists = await this.prisma.client.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Client not found');
    return this.prisma.auditEvent.findMany({
      where: { targetType: TARGET_TYPE, targetId: id },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: {
        id: true,
        action: true,
        actorUserId: true,
        actorName: true,
        actorEmail: true,
        changes: true,
        metadata: true,
        severity: true,
        result: true,
        occurredAt: true,
      },
    });
  }
}
