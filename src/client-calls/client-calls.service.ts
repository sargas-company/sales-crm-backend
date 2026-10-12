import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditResult,
  ClientCallClientType,
  ClientCallStatus,
  Prisma,
} from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateClientCallDto } from './dto/create-client-call.dto';
import {
  ClientCallSortBy,
  ClientCallSortDirection,
  ListClientCallsDto,
} from './dto/list-client-calls.dto';
import { UpdateClientCallDto } from './dto/update-client-call.dto';

const KYIV_TZ = 'Europe/Kiev';

function formatInTimezone(date: Date, tz: string): string {
  // IANA timezone (contains '/' or is a well-known name)
  if (tz.includes('/') || tz === 'UTC') {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  // Fixed offset: '+05:00', '-03:00', '+5', '-3'
  const match = tz.match(/^([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (match) {
    const sign = match[1] === '+' ? 1 : -1;
    const offsetMs =
      sign * (parseInt(match[2]) * 60 + parseInt(match[3] ?? '0')) * 60_000;
    return new Date(date.getTime() + offsetMs)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
  }

  return date.toISOString().slice(0, 16).replace('T', ' ');
}

function enrichCall<T extends { scheduledAt: Date; clientTimezone: string }>(
  call: T,
) {
  return {
    ...call,
    clientDateTime: formatInTimezone(call.scheduledAt, call.clientTimezone),
    kyivDateTime: formatInTimezone(call.scheduledAt, KYIV_TZ),
  };
}

@Injectable()
export class ClientCallsService {
  private readonly logger = new Logger(ClientCallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
    private readonly notifications: NotificationService,
  ) {}

  async create(dto: CreateClientCallDto, createdById: string) {
    // ClientCall owner restricted to Lead or Client only. The
    // `client_request` discriminator is kept in the enum for schema
    // compatibility with historical rows, but new calls MUST NOT be
    // created against a Website Request. The guard here is backed
    // by the DB CHECK `ClientCall_exactly_one_owner`.
    if (
      dto.clientType === ClientCallClientType.client_request ||
      dto.clientRequestId
    ) {
      throw new BadRequestException(
        'Calls can only be created for a Lead or a Client. Website Request is no longer a supported owner.',
      );
    }
    const providedIds = {
      leadId: dto.leadId ?? null,
      crmClientId: dto.crmClientId ?? null,
    };
    const providedCount = Object.values(providedIds).filter((v) => !!v).length;
    if (providedCount !== 1) {
      throw new BadRequestException(
        'Exactly one of leadId / crmClientId must be set',
      );
    }
    const expectedKey =
      dto.clientType === ClientCallClientType.lead ? 'leadId' : 'crmClientId';
    if (!providedIds[expectedKey]) {
      throw new BadRequestException(
        `clientType=${dto.clientType} but ${expectedKey} is missing`,
      );
    }

    // Scheduled time must be at least 30 minutes in the future so an
    // operator can't book a call that would miss the 60-minute
    // reminder window and would land in the past before anyone could
    // react. Rescheduling an existing call is checked by `update`.
    this.assertScheduledInFuture(new Date(dto.scheduledAt));

    if (dto.clientType === ClientCallClientType.lead) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId! },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    } else {
      const c = await this.prisma.client.findUnique({
        where: { id: dto.crmClientId! },
      });
      if (!c) throw new NotFoundException('Client not found');
    }

    const call = await this.prisma.clientCall.create({
      data: {
        clientType: dto.clientType,
        leadId:
          dto.clientType === ClientCallClientType.lead ? dto.leadId! : null,
        crmClientId:
          dto.clientType === ClientCallClientType.client
            ? dto.crmClientId!
            : null,
        clientRequestId: null,
        createdById,
        callTitle: dto.callTitle,
        meetingUrl: dto.meetingUrl ?? null,
        scheduledAt: new Date(dto.scheduledAt),
        clientTimezone: dto.clientTimezone,
        duration: dto.duration,
      },
    });

    await this.emitCallCreatedActivity(call, createdById);
    // "Call scheduled" PMS alert — fires once per successful create
    // of a scheduled (non-cancelled, non-completed) call.
    await this.emitScheduledNotification(call.id);

    return enrichCall(call);
  }

  /**
   * Guard used by create() and update() when the operator sets or
   * changes `scheduledAt`. Required by product: an operator cannot
   * save a call that would land in the past, and the 30-minute floor
   * keeps the 10-minute reminder from firing before the row has even
   * been committed.
   */
  private assertScheduledInFuture(when: Date): void {
    const minMs = Date.now() + 30 * 60 * 1000;
    if (when.getTime() < minMs) {
      throw new BadRequestException(
        'Scheduled time must be at least 30 minutes in the future.',
      );
    }
  }

  /**
   * Fires the "Call scheduled" PMS NotificationEvent after a call
   * has been committed. Pulled into a method so the call-site in
   * create() is a one-liner and the audit emission + notification
   * emission stay side by side.
   */
  private async emitScheduledNotification(callId: string): Promise<void> {
    try {
      await this.notifications.createEvent('CALL_SCHEDULED', { callId });
    } catch (err) {
      this.logger?.error(
        `Failed to create CALL_SCHEDULED NotificationEvent for call ${callId}: ${(err as Error).message}`,
      );
    }
  }

  private async emitRescheduledNotification(
    callId: string,
    oldScheduledAt: Date,
    newScheduledAt: Date,
  ): Promise<void> {
    try {
      await this.notifications.createEvent('CALL_RESCHEDULED', {
        callId,
        oldScheduledAt: oldScheduledAt.toISOString(),
        newScheduledAt: newScheduledAt.toISOString(),
      });
    } catch (err) {
      this.logger?.error(
        `Failed to create CALL_RESCHEDULED NotificationEvent for call ${callId}: ${(err as Error).message}`,
      );
    }
  }

  private async emitCancelledNotification(callId: string): Promise<void> {
    try {
      await this.notifications.createEvent('CALL_CANCELLED', { callId });
    } catch (err) {
      this.logger?.error(
        `Failed to create CALL_CANCELLED NotificationEvent for call ${callId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write an append-only `*.call_created` AuditEvent on the owner
   * entity so the Lead / Client / ClientRequest timeline surfaces
   * the call. Nothing from the call body (title, notes, meeting
   * link) is persisted on the event — only shape markers.
   */
  private async emitCallCreatedActivity(
    call: {
      id: string;
      clientType: ClientCallClientType;
      leadId: string | null;
      crmClientId: string | null;
      clientRequestId: string | null;
      scheduledAt: Date;
    },
    actorUserId: string,
  ) {
    if (call.clientType === ClientCallClientType.lead && call.leadId) {
      await this.audit.recordSafe({
        actorUserId,
        domain: 'leads',
        action: 'lead.call_created',
        targetType: 'Lead',
        targetId: call.leadId,
        targetHref: `/leads/preview/${call.leadId}`,
        result: AuditResult.SUCCESS,
        metadata: {
          callId: call.id,
          scheduledAt: call.scheduledAt.toISOString(),
        },
      });
    } else if (
      call.clientType === ClientCallClientType.client &&
      call.crmClientId
    ) {
      await this.audit.recordSafe({
        actorUserId,
        domain: 'clients',
        action: 'client.call_created',
        targetType: 'Client',
        targetId: call.crmClientId,
        targetHref: `/clients/${call.crmClientId}`,
        result: AuditResult.SUCCESS,
        metadata: {
          callId: call.id,
          scheduledAt: call.scheduledAt.toISOString(),
        },
      });
    } else if (
      call.clientType === ClientCallClientType.client_request &&
      call.clientRequestId
    ) {
      await this.audit.recordSafe({
        actorUserId,
        domain: 'client_requests',
        action: 'client_request.call_created',
        targetType: 'ClientRequest',
        targetId: call.clientRequestId,
        targetHref: `/client-requests/preview/${call.clientRequestId}`,
        result: AuditResult.SUCCESS,
        metadata: {
          callId: call.id,
          scheduledAt: call.scheduledAt.toISOString(),
        },
      });
    }
  }

  async findAll(dto: ListClientCallsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const offset = (page - 1) * limit;
    const dir: Prisma.SortOrder =
      dto.sortDirection ?? ClientCallSortDirection.desc;

    const where: Prisma.ClientCallWhereInput = dto.search
      ? { callTitle: { contains: dto.search, mode: 'insensitive' } }
      : {};

    const orderBy = this.buildOrderBy(dto.sortBy, dir);

    const [data, total] = await Promise.all([
      this.prisma.clientCall.findMany({
        where,
        orderBy,
        skip: offset,
        take: limit,
        include: {
          lead: {
            select: { id: true, firstName: true, lastName: true, companyName: true },
          },
          crmClient: {
            select: { id: true, firstName: true, lastName: true, company: true },
          },
          clientRequest: {
            select: { id: true, name: true, company: true },
          },
          // `createdBy` deliberately not selected (rev 2026-10-12 —
          // "created by" removed from the Client-Calls UI contract).
          // The `createdById` column stays on the row for audit.
        },
      }),
      this.prisma.clientCall.count({ where }),
    ]);

    return { data: data.map(enrichCall), total };
  }

  private buildOrderBy(
    sortBy: ClientCallSortBy | undefined,
    dir: Prisma.SortOrder,
  ): Prisma.ClientCallOrderByWithRelationInput {
    switch (sortBy) {
      case ClientCallSortBy.callTitle:
        return { callTitle: dir };
      case ClientCallSortBy.duration:
        return { duration: dir };
      case ClientCallSortBy.clientTimezone:
        return { clientTimezone: dir };
      case ClientCallSortBy.status:
        return { status: dir };
      case ClientCallSortBy.createdAt:
        return { createdAt: dir };
      case ClientCallSortBy.scheduledAt:
      default:
        return { scheduledAt: dir };
    }
  }

  async findOne(id: string) {
    const call = await this.prisma.clientCall.findUnique({
      where: { id },
      include: {
        lead: {
          select: { id: true, firstName: true, lastName: true, companyName: true },
        },
        crmClient: {
          select: { id: true, firstName: true, lastName: true, company: true },
        },
        clientRequest: {
          select: { id: true, name: true, company: true },
        },
      },
    });

    if (!call) throw new NotFoundException('ClientCall not found');

    return enrichCall(call);
  }

  async update(id: string, dto: UpdateClientCallDto) {
    const call = await this.prisma.clientCall.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('ClientCall not found');

    // Detect the two state transitions that trigger PMS notifications
    // AND reminder-row maintenance: a REAL time change (same ISO
    // string = not a reschedule) and a transition INTO cancelled.
    const newScheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const timeChanged =
      newScheduledAt !== null &&
      newScheduledAt.getTime() !== call.scheduledAt.getTime();
    const becomesCancelled =
      dto.status === ClientCallStatus.cancelled &&
      call.status !== ClientCallStatus.cancelled;

    // A reschedule to a past-ish time is just as invalid as a create
    // in the past — but editing notes / finishing / cancelling an
    // old call must still succeed, so we only check when the time is
    // actually changing.
    if (timeChanged && dto.status !== ClientCallStatus.cancelled && dto.status !== ClientCallStatus.completed) {
      this.assertScheduledInFuture(newScheduledAt!);
    }

    // Atomic: when the time changes we must update `scheduledAt`,
    // bump `rescheduledAt` (the reminder-anchor) and purge the old
    // `CallReminderSent` stamps as one unit. A crash between any two
    // of those left the previous version with stale stamps against a
    // new schedule — so the cron would skip reminders that should now
    // fire. Non-time edits (notes, title, status, etc.) stay a plain
    // single-row update.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.clientCall.update({
        where: { id },
        data: {
          callTitle: dto.callTitle,
          meetingUrl: dto.meetingUrl,
          scheduledAt: newScheduledAt ?? undefined,
          clientTimezone: dto.clientTimezone,
          duration: dto.duration,
          status: dto.status,
          notes: dto.notes,
          summary: dto.summary,
          transcriptUrl: dto.transcriptUrl,
          aiSummary: dto.aiSummary,
          ...(timeChanged ? { rescheduledAt: new Date() } : {}),
        },
      });

      if (timeChanged) {
        await tx.callReminderSent.deleteMany({ where: { callId: id } });
      }

      return row;
    });

    // Notifications are kicked outside the transaction: the DB state
    // the user asked for is already committed; a Discord-queue hiccup
    // must not roll back the reschedule itself.
    if (timeChanged) {
      await this.emitRescheduledNotification(id, call.scheduledAt, newScheduledAt!);
    }
    if (becomesCancelled) {
      await this.emitCancelledNotification(id);
    }

    return enrichCall(updated);
  }

  async remove(id: string) {
    const call = await this.prisma.clientCall.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('ClientCall not found');
    return this.prisma.clientCall.delete({ where: { id } });
  }

  /**
   * Bulk delete under the same permission as single-remove. Stale ids
   * are silently skipped — the caller sees how many rows actually
   * matched via `deleted`.
   */
  async bulkRemove(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    const result = await this.prisma.clientCall.deleteMany({
      where: { id: { in: ids } },
    });
    return { deleted: result.count };
  }
}
