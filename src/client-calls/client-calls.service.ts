import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientCallClientType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateClientCallDto } from './dto/create-client-call.dto';
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
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateClientCallDto, createdById: string) {
    if (dto.clientType === ClientCallClientType.lead) {
      if (!dto.leadId)
        throw new BadRequestException('leadId is required for type lead');
      const lead = await this.prisma.lead.findUnique({
        where: { id: dto.leadId },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    } else {
      if (!dto.clientRequestId)
        throw new BadRequestException(
          'clientRequestId is required for type client_request',
        );
      const cr = await this.prisma.clientRequest.findUnique({
        where: { id: dto.clientRequestId },
      });
      if (!cr) throw new NotFoundException('ClientRequest not found');
    }

    const call = await this.prisma.clientCall.create({
      data: {
        clientType: dto.clientType,
        leadId: dto.leadId ?? null,
        clientRequestId: dto.clientRequestId ?? null,
        createdById,
        callTitle: dto.callTitle,
        meetingUrl: dto.meetingUrl ?? null,
        scheduledAt: new Date(dto.scheduledAt),
        clientTimezone: dto.clientTimezone,
        duration: dto.duration,
      },
    });

    return enrichCall(call);
  }

  async findAll(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.clientCall.findMany({
        orderBy: { scheduledAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          lead: {
            select: { id: true, firstName: true, lastName: true, companyName: true },
          },
          clientRequest: {
            select: { id: true, name: true, company: true },
          },
          createdBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.clientCall.count(),
    ]);

    return { data: data.map(enrichCall), total };
  }

  async findOne(id: string) {
    const call = await this.prisma.clientCall.findUnique({
      where: { id },
      include: {
        lead: {
          select: { id: true, firstName: true, lastName: true, companyName: true },
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
}
