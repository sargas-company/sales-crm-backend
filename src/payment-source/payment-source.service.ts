import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditResult, AuditSeverity } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { safeDiff } from '../audit-event/audit-sanitizer';
import { CreatePaymentSourceDto } from './dto/create-payment-source.dto';
import { UpdatePaymentSourceDto } from './dto/update-payment-source.dto';

@Injectable()
export class PaymentSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreatePaymentSourceDto, actorId: string) {
    const created = await this.prisma.paymentSource.create({
      data: {
        name: dto.name,
        description: dto.description,
        currency: dto.currency ? dto.currency.toUpperCase() : 'USD',
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'paymentSource.create',
      targetType: 'PaymentSource',
      targetId: created.id,
      targetLabel: created.name,
      result: AuditResult.SUCCESS,
      metadata: { currency: created.currency, isActive: created.isActive },
    });
    return created;
  }

  findAll() {
    return this.prisma.paymentSource.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.paymentSource.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Payment source not found');
    return row;
  }

  async update(id: string, dto: UpdatePaymentSourceDto, actorId: string) {
    const existing = await this.findOne(id);
    const updated = await this.prisma.paymentSource.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.currency !== undefined
          ? { currency: dto.currency.toUpperCase() }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    const changes = safeDiff(
      {
        name: existing.name,
        description: existing.description,
        currency: existing.currency,
        isActive: existing.isActive,
      },
      {
        name: updated.name,
        description: updated.description,
        currency: updated.currency,
        isActive: updated.isActive,
      },
    );
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action:
        existing.isActive !== updated.isActive
          ? updated.isActive
            ? 'paymentSource.activate'
            : 'paymentSource.archive'
          : 'paymentSource.update',
      targetType: 'PaymentSource',
      targetId: id,
      targetLabel: updated.name,
      result: AuditResult.SUCCESS,
      changes: changes ?? null,
    });
    return updated;
  }

  async remove(id: string, actorId: string) {
    const existing = await this.findOne(id);
    await this.prisma.paymentSource.delete({ where: { id } });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'FINANCE',
      action: 'paymentSource.delete',
      targetType: 'PaymentSource',
      targetId: id,
      targetLabel: existing.name,
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
    });
  }
}
