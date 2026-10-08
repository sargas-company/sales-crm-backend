import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ClientCallClientType,
  PrismaClient,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { ClientCallsService } from './client-calls.service';
import type { CreateClientCallDto } from './dto/create-client-call.dto';

const prisma = new PrismaClient();
const auditStub = {
	recordSafe: async () => undefined,
	record: async () => undefined,
} as unknown as AuditEventService;
const svc = new ClientCallsService(
	prisma as unknown as PrismaService,
	auditStub,
);
const TAG = `cc-inv-${randomUUID().slice(0, 8)}`;

let leadId: string;
let clientId: string;
let creatorId: string;
const createdCallIds: string[] = [];

beforeAll(async () => {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error('No user in DB — fixture missing');
  creatorId = user.id;
  const lead = await prisma.lead.create({ data: { firstName: `${TAG}-l` } });
  const client = await prisma.client.create({
    data: { firstName: `${TAG}-c` },
  });
  leadId = lead.id;
  clientId = client.id;
});

afterAll(async () => {
  if (createdCallIds.length > 0) {
    await prisma.clientCall.deleteMany({ where: { id: { in: createdCallIds } } });
  }
  await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
  await prisma.client.delete({ where: { id: clientId } }).catch(() => undefined);
  await prisma.$disconnect();
});

const base = (): Omit<CreateClientCallDto, 'clientType' | 'leadId' | 'crmClientId' | 'clientRequestId'> => ({
  callTitle: 'Discovery call',
  scheduledAt: '2026-11-15T14:00:00.000Z',
  clientTimezone: 'Europe/Kiev',
  duration: 30,
});

describe('ClientCall — exactly-one-owner invariant', () => {
  it('creates a call owned by a Lead', async () => {
    const call = await svc.create(
      {
        ...base(),
        clientType: ClientCallClientType.lead,
        leadId,
      } as unknown as CreateClientCallDto,
      creatorId,
    );
    createdCallIds.push(call.id);
    expect(call.clientType).toBe('lead');
    expect(call.leadId).toBe(leadId);
    expect(call.crmClientId).toBeNull();
    expect(call.clientRequestId).toBeNull();
  });

  it('creates a call owned by a Client', async () => {
    const call = await svc.create(
      {
        ...base(),
        clientType: ClientCallClientType.client,
        crmClientId: clientId,
      } as unknown as CreateClientCallDto,
      creatorId,
    );
    createdCallIds.push(call.id);
    expect(call.clientType).toBe('client');
    expect(call.crmClientId).toBe(clientId);
    expect(call.leadId).toBeNull();
  });

  it('rejects two owners simultaneously', async () => {
    await expect(
      svc.create(
        {
          ...base(),
          clientType: ClientCallClientType.lead,
          leadId,
          crmClientId: clientId,
        } as unknown as CreateClientCallDto,
        creatorId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects type/owner mismatch (type=client but only leadId passed)', async () => {
    await expect(
      svc.create(
        {
          ...base(),
          clientType: ClientCallClientType.client,
          leadId,
        } as unknown as CreateClientCallDto,
        creatorId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DB CHECK still enforces the invariant for raw inserts', async () => {
    await expect(
      prisma.clientCall.create({
        data: {
          clientType: 'lead',
          leadId: null,
          crmClientId: null,
          clientRequestId: null,
          createdById: creatorId,
          callTitle: 't',
          scheduledAt: new Date(),
          clientTimezone: 'UTC',
          duration: 10,
        },
      }),
    ).rejects.toBeDefined();
  });
});
