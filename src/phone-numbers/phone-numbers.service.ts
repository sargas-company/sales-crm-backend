import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  AuditSeverity,
  PhoneMaintenanceStatus,
  PhoneOperator,
  PhoneStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import {
  computeNextMaintenanceDate,
  maskPhone,
  normalizePhone,
} from './phone-utils';

interface CreatePhoneDto {
  number: string;
  operator?: PhoneOperator;
  status?: PhoneStatus;
  holderEmployeeId?: string | null;
  holderName?: string | null;
  maintenanceRequired?: boolean;
  nextMaintenanceAt?: string | null;
  lastTopUpAt?: string | null;
  lastNetworkRegistrationAt?: string | null;
  notes?: string;
}

interface UpdatePhoneDto extends Partial<CreatePhoneDto> {}

interface ListPhonesQuery {
  q?: string;
  operator?: PhoneOperator;
  status?: PhoneStatus;
  maintenanceRequired?: boolean;
  maintenanceOverdue?: boolean;
  page?: number;
  limit?: number;
  sort?: 'number' | 'operator' | 'lastMaintenance' | 'nextMaintenance' | 'status';
  direction?: 'asc' | 'desc';
}

@Injectable()
export class PhoneNumbersService {
  private readonly logger = new Logger(PhoneNumbersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  // ─── CRUD ─────────────────────────────────────────────────────────

  async list(query: ListPhonesQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.PhoneNumberWhereInput = {
      ...(query.operator ? { operator: query.operator } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.maintenanceRequired !== undefined
        ? { maintenanceRequired: query.maintenanceRequired }
        : {}),
      ...(query.maintenanceOverdue
        ? { nextMaintenanceAt: { lte: new Date() } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { notes: { contains: query.q, mode: 'insensitive' } },
              {
                holder: {
                  OR: [
                    { firstName: { contains: query.q, mode: 'insensitive' } },
                    { lastName: { contains: query.q, mode: 'insensitive' } },
                    { email: { contains: query.q, mode: 'insensitive' } },
                  ],
                },
              },
              {
                bindings: {
                  some: {
                    OR: [
                      {
                        service: {
                          name: { contains: query.q, mode: 'insensitive' },
                        },
                      },
                      {
                        credentialProfile: {
                          name: { contains: query.q, mode: 'insensitive' },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const orderBy = this.buildOrderBy(query);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.phoneNumber.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: this.defaultInclude(),
      }),
      this.prisma.phoneNumber.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async get(id: string) {
    const phone = await this.prisma.phoneNumber.findUnique({
      where: { id },
      include: {
        ...this.defaultInclude(),
        maintenances: {
          orderBy: { dueAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!phone) throw new NotFoundException('Phone number not found');
    return phone;
  }

  async summary() {
    const [total, active, due, overdue, nextRow] = await Promise.all([
      this.prisma.phoneNumber.count(),
      this.prisma.phoneNumber.count({ where: { status: PhoneStatus.ACTIVE } }),
      this.prisma.phoneMaintenance.count({
        where: { status: PhoneMaintenanceStatus.DUE },
      }),
      this.prisma.phoneMaintenance.count({
        where: { status: PhoneMaintenanceStatus.OVERDUE },
      }),
      this.prisma.phoneMaintenance.findFirst({
        where: { status: { in: [PhoneMaintenanceStatus.DUE, PhoneMaintenanceStatus.OVERDUE] } },
        orderBy: { dueAt: 'asc' },
        select: { dueAt: true },
      }),
    ]);
    return {
      total,
      active,
      due,
      overdue,
      nextMaintenanceDate: nextRow?.dueAt?.toISOString() ?? null,
    };
  }

  async create(dto: CreatePhoneDto, actorId: string) {
    const number = normalizePhone(dto.number);
    const existing = await this.prisma.phoneNumber.findUnique({ where: { number } });
    if (existing) {
      throw new BadRequestException('Phone number already exists');
    }
    const nextMaintenance =
      dto.nextMaintenanceAt !== undefined && dto.nextMaintenanceAt !== null
        ? new Date(dto.nextMaintenanceAt)
        : dto.maintenanceRequired === false
          ? null
          : computeNextMaintenanceDate();
    const created = await this.prisma.phoneNumber.create({
      data: {
        number,
        operator: dto.operator ?? PhoneOperator.OTHER,
        status: dto.status ?? PhoneStatus.ACTIVE,
        holderEmployeeId: dto.holderEmployeeId ?? null,
        holderName: dto.holderName?.trim() || null,
        maintenanceRequired: dto.maintenanceRequired ?? true,
        nextMaintenanceAt: nextMaintenance,
        lastTopUpAt: dto.lastTopUpAt ? new Date(dto.lastTopUpAt) : null,
        lastNetworkRegistrationAt: dto.lastNetworkRegistrationAt
          ? new Date(dto.lastNetworkRegistrationAt)
          : null,
        notes: dto.notes ?? null,
      },
      include: this.defaultInclude(),
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.create',
      targetType: 'PhoneNumber',
      targetId: created.id,
      targetLabel: maskPhone(created.number),
      targetHref: `/phone-numbers/edit/${created.id}`,
      result: AuditResult.SUCCESS,
      metadata: { operator: created.operator, status: created.status },
    });
    return created;
  }

  async update(id: string, dto: UpdatePhoneDto, actorId: string) {
    const existing = await this.prisma.phoneNumber.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Phone number not found');

    const normalized =
      dto.number !== undefined ? normalizePhone(dto.number) : undefined;
    if (normalized && normalized !== existing.number) {
      const clash = await this.prisma.phoneNumber.findUnique({
        where: { number: normalized },
      });
      if (clash) throw new BadRequestException('Phone number already exists');
    }
    const updated = await this.prisma.phoneNumber.update({
      where: { id },
      data: {
        ...(normalized !== undefined ? { number: normalized } : {}),
        ...(dto.operator !== undefined ? { operator: dto.operator } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.holderEmployeeId !== undefined
          ? { holderEmployeeId: dto.holderEmployeeId }
          : {}),
        ...(dto.holderName !== undefined
          ? { holderName: dto.holderName?.trim() || null }
          : {}),
        ...(dto.maintenanceRequired !== undefined
          ? { maintenanceRequired: dto.maintenanceRequired }
          : {}),
        ...(dto.nextMaintenanceAt !== undefined
          ? {
              nextMaintenanceAt: dto.nextMaintenanceAt
                ? new Date(dto.nextMaintenanceAt)
                : null,
            }
          : {}),
        ...(dto.lastTopUpAt !== undefined
          ? { lastTopUpAt: dto.lastTopUpAt ? new Date(dto.lastTopUpAt) : null }
          : {}),
        ...(dto.lastNetworkRegistrationAt !== undefined
          ? {
              lastNetworkRegistrationAt: dto.lastNetworkRegistrationAt
                ? new Date(dto.lastNetworkRegistrationAt)
                : null,
            }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      include: this.defaultInclude(),
    });

    const changes = safeDiff(
      {
        number: existing.number,
        operator: existing.operator,
        status: existing.status,
        holderEmployeeId: existing.holderEmployeeId,
        maintenanceRequired: existing.maintenanceRequired,
        nextMaintenanceAt: existing.nextMaintenanceAt?.toISOString() ?? null,
      },
      {
        number: updated.number,
        operator: updated.operator,
        status: updated.status,
        holderEmployeeId: updated.holderEmployeeId,
        maintenanceRequired: updated.maintenanceRequired,
        nextMaintenanceAt: updated.nextMaintenanceAt?.toISOString() ?? null,
      },
    );
    const action =
      existing.holderEmployeeId !== updated.holderEmployeeId
        ? 'phone.holder.change'
        : existing.status !== updated.status
          ? 'phone.status.change'
          : 'phone.update';
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action,
      targetType: 'PhoneNumber',
      targetId: id,
      targetLabel: maskPhone(updated.number),
      targetHref: `/phone-numbers/edit/${id}`,
      result: AuditResult.SUCCESS,
      severity:
        existing.status !== updated.status
          ? AuditSeverity.WARNING
          : AuditSeverity.INFO,
      changes: changes ?? null,
    });
    return updated;
  }

  async disable(id: string, actorId: string) {
    const existing = await this.prisma.phoneNumber.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Phone number not found');
    await this.prisma.phoneNumber.update({
      where: { id },
      data: { status: PhoneStatus.DISABLED, maintenanceRequired: false },
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.disable',
      targetType: 'PhoneNumber',
      targetId: id,
      targetLabel: maskPhone(existing.number),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  // ─── Bindings ─────────────────────────────────────────────────────

  async listBindings(query: {
    q?: string;
    phoneNumberId?: string;
    serviceId?: string;
    profileId?: string;
    status?: PhoneStatus;
    page?: number;
    limit?: number;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.PhoneNumberBindingWhereInput = {
      ...(query.phoneNumberId ? { phoneNumberId: query.phoneNumberId } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...(query.profileId ? { credentialProfileId: query.profileId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              {
                service: {
                  name: { contains: query.q, mode: 'insensitive' },
                },
              },
              { phoneNumber: { number: { contains: query.q, mode: 'insensitive' } } },
              {
                credentialProfile: {
                  name: { contains: query.q, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.phoneNumberBinding.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          phoneNumber: true,
          service: { select: { id: true, name: true, slug: true } },
          credentialProfile: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.phoneNumberBinding.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async createBinding(
    dto: {
      phoneNumberId: string;
      serviceId: string;
      credentialProfileId?: string | null;
      status?: PhoneStatus;
      notes?: string;
    },
    actorId: string,
  ) {
    const phone = await this.prisma.phoneNumber.findUnique({
      where: { id: dto.phoneNumberId },
    });
    if (!phone) throw new NotFoundException('Phone number not found');
    const serviceId = (dto.serviceId ?? '').trim();
    if (!serviceId) throw new BadRequestException('serviceId required');
    const service = await this.prisma.phoneService.findUnique({
      where: { id: serviceId },
    });
    if (!service) throw new BadRequestException('Phone service not found');
    const created = await this.prisma.phoneNumberBinding.create({
      data: {
        phoneNumberId: dto.phoneNumberId,
        serviceId,
        credentialProfileId: dto.credentialProfileId ?? null,
        status: dto.status ?? PhoneStatus.ACTIVE,
        notes: dto.notes ?? null,
      },
      include: {
        phoneNumber: true,
        service: { select: { id: true, name: true, slug: true } },
        credentialProfile: { select: { id: true, name: true, slug: true } },
      },
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.binding.create',
      targetType: 'PhoneNumberBinding',
      targetId: created.id,
      targetLabel: `${maskPhone(phone.number)} → ${service.name}`,
      result: AuditResult.SUCCESS,
      metadata: {
        serviceId,
        serviceName: service.name,
        credentialProfileId: dto.credentialProfileId ?? null,
      },
    });
    return created;
  }

  async updateBinding(
    id: string,
    dto: {
      serviceId?: string;
      credentialProfileId?: string | null;
      status?: PhoneStatus;
      notes?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.phoneNumberBinding.findUnique({
      where: { id },
      include: { phoneNumber: true, service: true },
    });
    if (!existing) throw new NotFoundException('Binding not found');
    if (dto.serviceId !== undefined) {
      const service = await this.prisma.phoneService.findUnique({
        where: { id: dto.serviceId },
      });
      if (!service) throw new BadRequestException('Phone service not found');
    }
    const updated = await this.prisma.phoneNumberBinding.update({
      where: { id },
      data: {
        ...(dto.serviceId !== undefined ? { serviceId: dto.serviceId } : {}),
        ...(dto.credentialProfileId !== undefined
          ? { credentialProfileId: dto.credentialProfileId }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      include: {
        phoneNumber: true,
        service: { select: { id: true, name: true, slug: true } },
        credentialProfile: { select: { id: true, name: true, slug: true } },
      },
    });
    const changes = safeDiff(
      {
        serviceId: existing.serviceId,
        credentialProfileId: existing.credentialProfileId,
        status: existing.status,
      },
      {
        serviceId: updated.serviceId,
        credentialProfileId: updated.credentialProfileId,
        status: updated.status,
      },
    );
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.binding.update',
      targetType: 'PhoneNumberBinding',
      targetId: id,
      targetLabel: `${maskPhone(existing.phoneNumber.number)} → ${updated.service.name}`,
      result: AuditResult.SUCCESS,
      changes: changes ?? null,
    });
    return updated;
  }

  async removeBinding(id: string, actorId: string) {
    const existing = await this.prisma.phoneNumberBinding.findUnique({
      where: { id },
      include: { phoneNumber: true, service: true },
    });
    if (!existing) throw new NotFoundException('Binding not found');
    await this.prisma.phoneNumberBinding.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.binding.remove',
      targetType: 'PhoneNumberBinding',
      targetId: id,
      targetLabel: `${maskPhone(existing.phoneNumber.number)} → ${existing.service.name}`,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private defaultInclude(): Prisma.PhoneNumberInclude {
    return {
      holder: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      bindings: {
        orderBy: { updatedAt: 'desc' },
        include: {
          service: { select: { id: true, name: true, slug: true } },
          credentialProfile: { select: { id: true, name: true } },
        },
      },
    };
  }

  private buildOrderBy(
    q: ListPhonesQuery,
  ): Prisma.PhoneNumberOrderByWithRelationInput {
    const dir: Prisma.SortOrder = q.direction ?? 'asc';
    switch (q.sort) {
      case 'operator':
        return { operator: dir };
      case 'lastMaintenance':
        return { lastNetworkRegistrationAt: { sort: dir, nulls: 'last' } };
      case 'nextMaintenance':
        return { nextMaintenanceAt: { sort: dir, nulls: 'last' } };
      case 'status':
        return { status: dir };
      case 'number':
      default:
        return { number: dir };
    }
  }
}
