import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditEventService } from '../audit-event/audit-event.service';
import { ClientService } from './client.service';
import type { CreateClientDto } from './dto/create-client.dto';

/* Integration tests — hit the real local Postgres via Prisma. All rows
 * created here are tagged so afterAll can clean them up without
 * disturbing other data. */
const prisma = new PrismaClient();
const prismaSvc = prisma as unknown as PrismaService;
const audit = {
  recordSafe: async () => undefined,
  record: async () => undefined,
} as unknown as AuditEventService;
const svc = new ClientService(prismaSvc, audit);
const user = {
  id: '00000000-0000-0000-0000-000000000002',
  permissions: new Set<string>(['clients:create', 'clients:update', 'clients:delete']),
};
const TAG = `client-spec-${randomUUID().slice(0, 8)}`;
const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.client.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
});

const trackCreate = async (payload: Partial<CreateClientDto>) => {
  const dto = {
    firstName: payload.firstName ?? 'Alice',
    lastName: payload.lastName ?? `${TAG}-${randomUUID().slice(0, 6)}`,
    company: payload.company ?? null,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    source: payload.source ?? null,
    profileUrl: payload.profileUrl ?? null,
    status: payload.status,
    clientSince: payload.clientSince ?? null,
    notes: payload.notes ?? null,
  } as unknown as CreateClientDto;
  const row = await svc.create(dto, user);
  createdIds.push(row.id);
  return row;
};

describe('ClientService — CRUD + search + sort', () => {
  let aId: string;
  let bId: string;

  beforeAll(async () => {
    const a = await trackCreate({
      firstName: 'Alpha',
      email: 'alpha@example.test',
      phone: '+14155550123',
      source: 'upwork',
    });
    const b = await trackCreate({
      firstName: 'Beta',
      company: 'Beta Industries',
      source: 'referral',
    });
    aId = a.id;
    bId = b.id;
  });

  it('persists firstName and status defaults', async () => {
    const row = await prisma.client.findUnique({ where: { id: aId } });
    expect(row?.firstName).toBe('Alpha');
    expect(row?.status).toBe('ACTIVE');
  });

  it('search matches by email substring', async () => {
    const { data } = await svc.findAll({
      search: 'alpha@example',
      limit: 10,
    } as unknown as Parameters<typeof svc.findAll>[0]);
    expect(data.map((c) => c.id)).toContain(aId);
  });

  it('filter by source narrows the result', async () => {
    const { data } = await svc.findAll({
      source: 'referral',
      limit: 10,
    } as unknown as Parameters<typeof svc.findAll>[0]);
    const ids = data.map((c) => c.id);
    expect(ids).toContain(bId);
    expect(ids).not.toContain(aId);
  });

  it('refuses delete when a project points at the client', async () => {
    const projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        name: `${TAG}-proj`,
        crmClientId: aId,
      },
    });
    try {
      await expect(svc.remove(aId, user)).rejects.toBeInstanceOf(
        ConflictException,
      );
    } finally {
      await prisma.project.delete({ where: { id: projectId } });
    }
  });

  it('deletes when no projects reference the client', async () => {
    const row = await trackCreate({ firstName: 'Deletable' });
    await svc.remove(row.id, user);
    const found = await prisma.client.findUnique({ where: { id: row.id } });
    expect(found).toBeNull();
    // already removed; drop from cleanup list
    const idx = createdIds.indexOf(row.id);
    if (idx >= 0) createdIds.splice(idx, 1);
  });

  it('activity() throws NotFound when the client is missing', async () => {
    await expect(
      svc.activity('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findDuplicates returns matches by normalised email', async () => {
    const list = await svc.findDuplicates({
      email: 'ALPHA@example.test',
      phone: null,
    });
    expect(list.map((c) => c.id)).toContain(aId);
  });
});
