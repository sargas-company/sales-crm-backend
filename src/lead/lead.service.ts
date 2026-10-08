import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  Lead,
  LeadStatus,
  Prisma,
} from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { AuthUser } from '../auth/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import {
  LeadSortBy,
  LeadSortDirection,
  ListLeadsDto,
} from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

const DOMAIN = 'leads';
const TARGET_TYPE = 'Lead';

const label = (
  l: Pick<Lead, 'firstName' | 'lastName' | 'companyName'>,
): string =>
  [l.firstName, l.lastName].filter(Boolean).join(' ').trim() ||
  l.companyName ||
  'lead';

@Injectable()
export class LeadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateLeadDto, user: AuthUser) {
    const created = await this.prisma.lead.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        companyName: dto.companyName,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        clientType: dto.clientType,
        rate: dto.rate,
        location: dto.location,
        status: dto.status ?? LeadStatus.NEW,
        temperature: dto.temperature ?? null,
        source: dto.source ?? null,
        profileUrl: dto.profileUrl ?? null,
        notes: dto.notes ?? null,
      },
    });

    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: DOMAIN,
      action: 'lead.create',
      targetType: TARGET_TYPE,
      targetId: created.id,
      targetLabel: label(created),
      targetHref: `/leads/preview/${created.id}`,
      result: AuditResult.SUCCESS,
      metadata: {
        status: created.status,
        temperature: created.temperature,
        source: created.source,
        hasEmail: created.email !== null,
        hasPhone: created.phone !== null,
      },
    });

    return created;
  }

  createFromProposal(
    proposalId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.lead.create({
      data: { proposalId },
    });
  }

  async findAll(dto: ListLeadsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? LeadSortDirection.desc;

    const where: Prisma.LeadWhereInput = {
      ...(dto.status && dto.status.length > 0
        ? { status: { in: dto.status } }
        : {}),
      ...(dto.temperature && dto.temperature.length > 0
        ? { temperature: { in: dto.temperature } }
        : {}),
      ...(dto.source ? { source: dto.source } : {}),
      ...(dto.createdFrom || dto.createdTo
        ? {
            createdAt: {
              ...(dto.createdFrom ? { gte: new Date(dto.createdFrom) } : {}),
              ...(dto.createdTo ? { lte: new Date(dto.createdTo) } : {}),
            },
          }
        : {}),
      ...(dto.search
        ? {
            OR: [
              { firstName: { contains: dto.search, mode: 'insensitive' } },
              { lastName: { contains: dto.search, mode: 'insensitive' } },
              { companyName: { contains: dto.search, mode: 'insensitive' } },
              { email: { contains: dto.search, mode: 'insensitive' } },
              { phone: { contains: dto.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: { proposal: { select: { id: true, title: true } } },
      }),
      this.prisma.lead.count({ where }),
    ]);

    return { data, total };
  }

  private buildOrderBy(
    sortBy: LeadSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.LeadOrderByWithRelationInput {
    switch (sortBy) {
      case LeadSortBy.number:
        return { number: dir };
      case LeadSortBy.firstName:
        return { firstName: { sort: dir, nulls: 'last' } };
      case LeadSortBy.company:
        return { companyName: { sort: dir, nulls: 'last' } };
      case LeadSortBy.clientType:
        return { clientType: { sort: dir, nulls: 'last' } };
      case LeadSortBy.status:
        return { status: dir };
      case LeadSortBy.temperature:
        return { temperature: { sort: dir, nulls: 'last' } };
      case LeadSortBy.rate:
        return { rate: { sort: dir, nulls: 'last' } };
      case LeadSortBy.location:
        return { location: { sort: dir, nulls: 'last' } };
      case LeadSortBy.email:
        return { email: { sort: dir, nulls: 'last' } };
      case LeadSortBy.phone:
        return { phone: { sort: dir, nulls: 'last' } };
      case LeadSortBy.repliedAt:
        return { repliedAt: dir };
      case LeadSortBy.updatedAt:
        return { updatedAt: dir };
      case LeadSortBy.createdAt:
      default:
        return { createdAt: dir };
    }
  }

  async findOne(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: { proposal: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async remove(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');

    await this.prisma.lead.delete({ where: { id } });

    await this.audit.recordSafe({
      actorUserId: user.id,
      domain: DOMAIN,
      action: 'lead.delete',
      targetType: TARGET_TYPE,
      targetId: id,
      targetLabel: label(lead),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });

    return lead;
  }

  async update(id: string, dto: UpdateLeadDto, user: AuthUser) {
    const existing = await this.prisma.lead.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Lead not found');

    const now = new Date();
    const statusChanged =
      dto.status !== undefined && dto.status !== existing.status;
    const temperatureChanged =
      dto.temperature !== undefined &&
      (dto.temperature ?? null) !== existing.temperature;
    const noteChanged =
      dto.notes !== undefined && (dto.notes ?? null) !== existing.notes;
    const contactChanged =
      (dto.email !== undefined && (dto.email ?? null) !== existing.email) ||
      (dto.phone !== undefined && (dto.phone ?? null) !== existing.phone);
    const isBecomingHold =
      statusChanged && dto.status === LeadStatus.ON_HOLD;
    const isBecomingWon =
      statusChanged && dto.status === LeadStatus.WON;

    const updated = await this.prisma.lead.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        companyName: dto.companyName,
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        status: dto.status,
        clientType: dto.clientType,
        rate: dto.rate,
        location: dto.location,
        ...(dto.temperature !== undefined
          ? { temperature: dto.temperature }
          : {}),
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        ...(dto.profileUrl !== undefined ? { profileUrl: dto.profileUrl } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(isBecomingHold && { holdAt: now }),
        ...(isBecomingWon && { acceptedAt: now }),
      },
    });

    if (statusChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'lead.status_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/leads/preview/${id}`,
        result: AuditResult.SUCCESS,
        changes: {
          status: { before: existing.status, after: updated.status },
        },
      });
    }
    if (temperatureChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'lead.temperature_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/leads/preview/${id}`,
        result: AuditResult.SUCCESS,
        changes: {
          temperature: {
            before: existing.temperature,
            after: updated.temperature,
          },
        },
      });
    }
    if (noteChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'lead.note_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/leads/preview/${id}`,
        result: AuditResult.SUCCESS,
        changes: { notes: { changed: true } },
      });
    }
    if (contactChanged) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'lead.contact_changed',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/leads/preview/${id}`,
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
    if (
      !statusChanged &&
      !temperatureChanged &&
      !noteChanged &&
      !contactChanged
    ) {
      await this.audit.recordSafe({
        actorUserId: user.id,
        domain: DOMAIN,
        action: 'lead.update',
        targetType: TARGET_TYPE,
        targetId: id,
        targetLabel: label(updated),
        targetHref: `/leads/preview/${id}`,
        result: AuditResult.SUCCESS,
      });
    }

    return updated;
  }

  async findDuplicates(opts: {
    email?: string | null;
    phone?: string | null;
    excludeId?: string;
  }) {
    if (!opts.email && !opts.phone) return [];
    const or: Prisma.LeadWhereInput[] = [];
    if (opts.email) or.push({ email: opts.email.toLowerCase() });
    if (opts.phone) or.push({ phone: opts.phone });
    return this.prisma.lead.findMany({
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
        companyName: true,
        email: true,
        phone: true,
        status: true,
      },
      take: 10,
    });
  }

  async activity(id: string) {
    const exists = await this.prisma.lead.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Lead not found');
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
