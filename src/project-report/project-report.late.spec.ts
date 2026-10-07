/**
 * MANUAL ProjectReport create → late-report enqueue parity.
 *
 * Covers:
 *   - MANUAL create AFTER the active profile's `dailyDigestAt` →
 *     calls `DiscordLateReportService.enqueue` once;
 *   - MANUAL create BEFORE the deadline → does NOT call enqueue;
 *   - MANUAL create with zero project members → 422 and no enqueue;
 *   - enqueue throwing does NOT propagate out of create();
 *   - UPDATE never calls enqueue regardless of time.
 *
 * Prisma is a thin stub — `$transaction(cb)` is short-circuited to
 * `cb(tx)` and the stub records what the service tried to write.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ProjectReportSource } from '@prisma/client';

import type { DiscordLateReportService } from '../discord-integration/discord-late-report.service';
import { ProjectReportService } from './project-report.service';

function makeLateReports() {
  const enqueue = jest.fn(async () => undefined);
  return { enqueue } as unknown as DiscordLateReportService & {
    enqueue: jest.Mock;
  };
}

function makePrismaStub(opts: {
  createdAt: Date;
  reportId?: string;
  activeProfile: { timezone: string; dailyDigestAt: string } | null;
  members?: Array<{ id: string; firstName: string; lastName: string }>;
}) {
  const projectId = 'p-1';
  const reportId = opts.reportId ?? 'r-1';
  const members = (opts.members ?? [
    { id: 'e-1', firstName: 'Lee', lastName: 'Doe' },
  ]).map((m) => ({ employeeId: m.id, employee: m }));
  const base = {
    project: {
      findUnique: jest.fn(async () => ({ id: projectId })),
    },
    employee: {
      findUnique: jest.fn(async () => ({ id: 'e-1' })),
    },
    projectMember: {
      findUnique: jest.fn(async () => ({ projectId })),
      findMany: jest.fn(async () => members),
    },
    projectReport: {
      findUnique: jest.fn(
        async (args: { where: Record<string, unknown> }) => {
          // create path looks up by composite (projectId, reportDate) —
          // return null so the create flow proceeds. update path looks
          // up by id — return the row shape it expects.
          if ('projectId_reportDate' in args.where) return null;
          return {
            id: reportId,
            projectId,
            source: ProjectReportSource.MANUAL,
          };
        },
      ),
      create: jest.fn(async () => ({
        id: reportId,
        projectId,
        reportDate: new Date('2026-02-10T00:00:00.000Z'),
        hours: 5,
        content: 'manual',
        source: ProjectReportSource.MANUAL,
        discordUserId: null,
        discordUsername: null,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        project: { id: projectId, name: 'Proj', status: 'active' },
        contributors: members.map((m) => ({
          id: `c-${m.employeeId}`,
          reportId,
          employeeId: m.employeeId,
          firstNameSnapshot: m.employee.firstName,
          lastNameSnapshot: m.employee.lastName,
          createdAt: opts.createdAt,
          employee: m.employee,
        })),
      })),
      update: jest.fn(async () => ({
        id: reportId,
        projectId,
        reportDate: new Date('2026-02-10T00:00:00.000Z'),
        hours: 4,
        content: 'updated',
        source: ProjectReportSource.MANUAL,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        project: { id: projectId, name: 'Proj', status: 'active' },
        contributors: [],
      })),
    },
    discordProfile: {
      findFirst: jest.fn(async () => opts.activeProfile),
    },
    $executeRaw: jest.fn(async () => 1),
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(base),
  };
  return base;
}

const ownerUser = {
  id: 'u-1',
  isOwner: true,
  roleNames: ['owner'],
  permissions: new Set<string>(['project_reports:create', 'projects:view_any']),
} as unknown as Parameters<ProjectReportService['create']>[1];

const dto = {
  projectId: 'p-1',
  reportDate: '2026-02-10',
  hours: 5,
  content: 'late manual create',
} as unknown as Parameters<ProjectReportService['create']>[0];

describe('ProjectReportService.create — MANUAL late enqueue', () => {
  it('enqueues a late delivery when createdAt is at or past the deadline', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'), // 19:30 Kyiv (winter)
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).toHaveBeenCalledTimes(1);
    const call = late.enqueue.mock.calls[0][0] as {
      reportId: string;
      hours: number;
      isLate: boolean;
    };
    expect(call.reportId).toBe('r-1');
    expect(call.hours).toBe(5);
    expect(call.isLate).toBe(true);
  });

  it('does NOT enqueue when createdAt is strictly before the deadline', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T12:00:00.000Z'), // 14:00 Kyiv
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('18:59 Kyiv is NOT late', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T16:59:00.000Z'), // 18:59 Kyiv
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('zero-member project → 422 and no enqueue', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
      members: [],
    });
    const svc = new ProjectReportService(prisma as never, late);
    await expect(svc.create(dto, ownerUser)).rejects.toMatchObject({
      status: 422,
    });
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('enqueue throwing does NOT propagate out of create()', async () => {
    const late = {
      enqueue: jest.fn(async () => {
        throw new Error('Bot abc.def.ghi outage');
      }),
    } as unknown as DiscordLateReportService & { enqueue: jest.Mock };
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await expect(svc.create(dto, ownerUser)).resolves.toMatchObject({
      id: 'r-1',
    });
  });

  it('UPDATE does NOT enqueue regardless of time (silent-by-design)', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.update('r-1', { hours: 4 } as never, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('no active DiscordProfile → no enqueue', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'),
      activeProfile: null,
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });
});
