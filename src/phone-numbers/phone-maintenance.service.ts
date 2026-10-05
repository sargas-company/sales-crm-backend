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
  PhoneStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { SettingsService } from '../settings/settings.service';
import { SK } from '../settings/settings-registry';
import { computeNextMaintenanceDate, maskPhone } from './phone-utils';

interface CompleteDto {
  networkRegistered: boolean;
  toppedUp: boolean;
  topUpAmount?: number;
  notes?: string;
}

@Injectable()
export class PhoneMaintenanceService {
  private readonly logger = new Logger(PhoneMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly settings: SettingsService,
  ) {}

  /** Effective default top-up amount in ₴ — driven by the operator
   *  setting, falls back to 10 ₴ when the setting is missing or
   *  invalid. Clamped to the same bounds the registry declares. */
  async getDefaultTopUpAmount(): Promise<number> {
    const raw = await this.settings.getNumberForKey(
      SK.PHONE_DEFAULTS_TOPUP_AMOUNT,
      10,
    );
    if (!Number.isFinite(raw) || raw < 0) return 10;
    return Math.min(1000, Math.max(0, raw));
  }

  /** Current open (DUE + OVERDUE) tasks, newest-due-first. */
  async listOpen() {
    return this.prisma.phoneMaintenance.findMany({
      where: {
        status: {
          in: [PhoneMaintenanceStatus.DUE, PhoneMaintenanceStatus.OVERDUE],
        },
        // Skip DISABLED numbers — either not activated or decommissioned,
        // top-up/registration would be a waste.
        phoneNumber: {
          status: { not: 'DISABLED' },
        },
      },
      orderBy: [{ status: 'desc' }, { dueAt: 'asc' }],
      include: {
        phoneNumber: {
          select: {
            id: true,
            number: true,
            operator: true,
            status: true,
            holder: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
  }

  /** Completed history, paginated. */
  async listHistory(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Prisma.PhoneMaintenanceWhereInput = {
      status: {
        in: [PhoneMaintenanceStatus.COMPLETED, PhoneMaintenanceStatus.SKIPPED],
      },
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.phoneMaintenance.findMany({
        where,
        orderBy: { completedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          phoneNumber: { select: { id: true, number: true, operator: true } },
        },
      }),
      this.prisma.phoneMaintenance.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /** Mark one checklist action (network or topup) and finalize the task
   *  when both are confirmed. Idempotent — repeated calls to the same
   *  action do not reset `completedByUserId`. */
  async complete(id: string, dto: CompleteDto, actorId: string) {
    const task = await this.prisma.phoneMaintenance.findUnique({
      where: { id },
      include: { phoneNumber: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (
      task.status === PhoneMaintenanceStatus.COMPLETED ||
      task.status === PhoneMaintenanceStatus.SKIPPED
    ) {
      throw new BadRequestException('Task is already closed');
    }

    const now = new Date();
    const nextNetwork =
      dto.networkRegistered && !task.networkRegisteredAt ? now : task.networkRegisteredAt;
    const nextTopup =
      dto.toppedUp && !task.toppedUpAt ? now : task.toppedUpAt;
    const bothDone = !!nextNetwork && !!nextTopup;

    // When the operator ticks "topped up" without supplying an amount,
    // fall back to the configured workspace default (see
    // `PHONE_DEFAULTS_TOPUP_AMOUNT`). Explicit values always win.
    let effectiveTopUp: Prisma.Decimal | null;
    if (dto.topUpAmount !== undefined) {
      effectiveTopUp = new Prisma.Decimal(dto.topUpAmount);
    } else if (dto.toppedUp && !task.toppedUpAt && task.topUpAmount == null) {
      effectiveTopUp = new Prisma.Decimal(
        await this.getDefaultTopUpAmount(),
      );
    } else {
      effectiveTopUp = task.topUpAmount;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.phoneMaintenance.update({
        where: { id },
        data: {
          networkRegisteredAt: nextNetwork,
          toppedUpAt: nextTopup,
          topUpAmount: effectiveTopUp,
          notes: dto.notes !== undefined ? dto.notes : task.notes,
          status: bothDone
            ? PhoneMaintenanceStatus.COMPLETED
            : task.status === PhoneMaintenanceStatus.OVERDUE
              ? PhoneMaintenanceStatus.OVERDUE
              : PhoneMaintenanceStatus.DUE,
          completedAt: bothDone ? now : null,
          completedByUserId: bothDone ? actorId : null,
        },
      });

      if (bothDone) {
        // Propagate to PhoneNumber and schedule the next cycle.
        const next = computeNextMaintenanceDate(now);
        await tx.phoneNumber.update({
          where: { id: task.phoneNumberId },
          data: {
            lastNetworkRegistrationAt: nextNetwork,
            lastTopUpAt: nextTopup,
            nextMaintenanceAt: next,
          },
        });
      }
      return row;
    });

    // Audit — one event per checklist action; one more on completion.
    if (dto.networkRegistered && !task.networkRegisteredAt) {
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'SETTINGS',
        action: 'phone.maintenance.network',
        targetType: 'PhoneMaintenance',
        targetId: id,
        targetLabel: maskPhone(task.phoneNumber.number),
        result: AuditResult.SUCCESS,
      });
    }
    if (dto.toppedUp && !task.toppedUpAt) {
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'SETTINGS',
        action: 'phone.maintenance.topup',
        targetType: 'PhoneMaintenance',
        targetId: id,
        targetLabel: maskPhone(task.phoneNumber.number),
        result: AuditResult.SUCCESS,
        metadata: { amount: dto.topUpAmount ?? null },
      });
    }
    if (bothDone) {
      await this.audit.recordSafe({
        actorUserId: actorId,
        domain: 'SETTINGS',
        action: 'phone.maintenance.completed',
        targetType: 'PhoneMaintenance',
        targetId: id,
        targetLabel: maskPhone(task.phoneNumber.number),
        result: AuditResult.SUCCESS,
      });
    }
    return updated;
  }

  async skip(id: string, actorId: string, reason?: string) {
    const task = await this.prisma.phoneMaintenance.findUnique({
      where: { id },
      include: { phoneNumber: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.phoneMaintenance.update({
        where: { id },
        data: {
          status: PhoneMaintenanceStatus.SKIPPED,
          completedAt: now,
          completedByUserId: actorId,
          notes: reason ?? task.notes,
        },
      });
      // Still schedule the next cycle so the loop continues.
      const next = computeNextMaintenanceDate(now);
      await tx.phoneNumber.update({
        where: { id: task.phoneNumberId },
        data: { nextMaintenanceAt: next },
      });
      return row;
    });
    await this.audit.recordSafe({
      actorUserId: actorId,
      domain: 'SETTINGS',
      action: 'phone.maintenance.skipped',
      targetType: 'PhoneMaintenance',
      targetId: id,
      targetLabel: maskPhone(task.phoneNumber.number),
      result: AuditResult.SUCCESS,
      severity: AuditSeverity.WARNING,
      metadata: { reason: reason ?? null },
    });
    return updated;
  }

  /**
   * Scheduler helper — ensure every PhoneNumber that requires maintenance
   * has an open task when its `nextMaintenanceAt` is due. Also flips DUE
   * tasks that are past their dueAt to OVERDUE.
   */
  async ensureTasks(now: Date = new Date()): Promise<{
    created: number;
    overdue: number;
  }> {
    const candidates = await this.prisma.phoneNumber.findMany({
      where: {
        maintenanceRequired: true,
        status: { in: [PhoneStatus.ACTIVE, PhoneStatus.HOLD] },
        nextMaintenanceAt: { lte: now },
      },
      select: { id: true, nextMaintenanceAt: true },
    });
    let created = 0;
    for (const phone of candidates) {
      if (!phone.nextMaintenanceAt) continue;
      try {
        await this.prisma.phoneMaintenance.create({
          data: {
            phoneNumberId: phone.id,
            dueAt: phone.nextMaintenanceAt,
            status: PhoneMaintenanceStatus.DUE,
          },
        });
        created++;
      } catch (err) {
        // Unique(phoneNumberId, dueAt) protects us from duplicates.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        this.logger.error(`ensureTasks: ${(err as Error).message}`);
      }
    }
    // Flip DUE → OVERDUE for anything past the dueAt.
    const flipped = await this.prisma.phoneMaintenance.updateMany({
      where: {
        status: PhoneMaintenanceStatus.DUE,
        dueAt: { lt: now },
      },
      data: { status: PhoneMaintenanceStatus.OVERDUE },
    });
    return { created, overdue: flipped.count };
  }
}
