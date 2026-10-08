import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditResult, ClientCallClientType, Prisma } from '@prisma/client';

import { AuditEventService } from '../audit-event/audit-event.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventService,
  ) {}

  async create(dto: CreateClientCallDto, createdById: string) {
    // Exactly-one-owner invariant. The DB CHECK constraint
    // `ClientCall_exactly_one_owner` is the final arbiter; this check
    // raises a friendlier 400 before the SQL error surfaces, and
    // additionally refuses extraneous owner ids that don't match the
    // declared `clientType` discriminator.
    const providedIds = {
      leadId: dto.leadId ?? null,
      crmClientId: dto.crmClientId ?? null,
      clientRequestId: dto.clientRequestId ?? null,
    };
    const providedCount = Object.values(providedIds).filter((v) => !!v).length;
    if (providedCount !== 1) {
      throw new BadRequestException(
        'Exactly one of leadId / crmClientId / clientRequestId must be set',
      );
    }
    const expectedKey =
      dto.clientType === ClientCallClientType.lead
        ? 'leadId'
        : dto.clientType === ClientCallClientType.client
          ? 'crmClientId'
          : 'clientRequestId';
    if (!providedIds[expectedKey]) {
      throw new BadRequestException(
        `clientType=${dto.clientType} but ${expectedKey} is missing`,
      );
    }

    if (dto.clientType === ClientCallClientType.lead) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId! },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    } else if (dto.clientType === ClientCallClientType.client) {
      const c = await this.prisma.client.findUnique({
        where: { id: dto.crmClientId! },
      });
      if (!c) throw new NotFoundException('Client not found');
    } else {
      const cr = await this.prisma.clientRequest.findUnique({
        where: { id: dto.clientRequestId! },
      });
      if (!cr) throw new NotFoundException('ClientRequest not found');
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
        clientRequestId:
          dto.clientType === ClientCallClientType.client_request
            ? dto.clientRequestId!
            : null,
        createdById,
        callTitle: dto.callTitle,
        meetingUrl: dto.meetingUrl ?? null,
        scheduledAt: new Date(dto.scheduledAt),
        clientTimezone: dto.clientTimezone,
        duration: dto.duration,
      },
    });

    await this.emitCallCreatedActivity(call, createdById);

    return enrichCall(call);
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
          createdBy: {
            select: { id: true, firstName: true, lastName: true },
          },
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
      case ClientCallSortBy.createdBy:
        return { createdBy: { firstName: dir } };
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
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    if (!call) throw new NotFoundException('ClientCall not found');

    return enrichCall(call);
  }

  async update(id: string, dto: UpdateClientCallDto) {
    const call = await this.prisma.clientCall.findUnique({ where: { id } });
    if (!call) throw new NotFoundException('ClientCall not found');

    const updated = await this.prisma.clientCall.update({
      where: { id },
      data: {
        callTitle: dto.callTitle,
        meetingUrl: dto.meetingUrl,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        clientTimezone: dto.clientTimezone,
        duration: dto.duration,
        status: dto.status,
        notes: dto.notes,
        summary: dto.summary,
        transcriptUrl: dto.transcriptUrl,
        aiSummary: dto.aiSummary,
      },
    });

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
