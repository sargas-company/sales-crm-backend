/**
 * MANUAL ProjectReport create → late-report enqueue parity.
 *
 * Covers:
 *   - MANUAL create AFTER the active profile's `dailyDigestAt` →
 *     calls `DiscordLateReportService.enqueue` with the correct
 *     snapshot;
 *   - MANUAL create BEFORE the deadline → does NOT call enqueue;
 *   - MANUAL update → does NOT call enqueue;
 *   - a thrown enqueue error does NOT propagate (so the committed
 *     ProjectReport is not reflected as failed to the caller).
 *
 * Prisma is a thin stub — the test exercises `enqueueLateDeliveryIfNeeded`
 * directly via the public `create` path, with `prisma.$transaction`
 * short-circuited to call the callback with the stub as `tx`.
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

/**
 * Minimal Prisma stub: supports the project / employee / membership
 * assertions in `create`, routes `$transaction(cb)` into the stub as
 * `tx`, and surfaces the row that `create` wrote back to the service.
 */
function makePrismaStub(opts: {
  createdAt: Date;
  reportId?: string;
  activeProfile: { timezone: string; dailyDigestAt: string } | null;
}) {
  const projectId = 'p-1';
  const employeeId = 'e-1';
  const reportId = opts.reportId ?? 'r-1';
  const base = {
    project: {
      findUnique: jest.fn(async () => ({ id: projectId })),
    },
    employee: {
      findUnique: jest.fn(async () => ({ id: employeeId })),
    },
    projectMember: {
      findUnique: jest.fn(async () => ({ projectId })),
    },
    projectReport: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({
        id: reportId,
        projectId,
        employeeId,
        reportDate: new Date('2026-02-10T00:00:00.000Z'),
        hours: 5,
        content: 'manual',
        source: ProjectReportSource.MANUAL,
        discordUserId: null,
        discordUsername: null,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        project: { id: projectId, name: 'Proj', status: 'active' },
        employee: {
          id: employeeId,
          firstName: 'Lee',
          lastName: 'Doe',
          positions: [],
          userId: 'u-1',
        },
      })),
      update: jest.fn(async () => ({
        id: reportId,
        projectId,
        employeeId,
        reportDate: new Date('2026-02-10T00:00:00.000Z'),
        hours: 4,
        content: 'updated',
        source: ProjectReportSource.MANUAL,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        project: { id: projectId, name: 'Proj', status: 'active' },
        employee: {
          id: employeeId,
          firstName: 'Lee',
          lastName: 'Doe',
          positions: [],
          userId: 'u-1',
        },
      })),
      findUnique: jest.fn(async () => ({
        id: reportId,
        employeeId,
        projectId,
        source: ProjectReportSource.MANUAL,
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
  employeeId: 'e-1',
  reportDate: '2026-02-10',
  hours: 5,
  content: 'late manual create',
} as unknown as Parameters<ProjectReportService['create']>[0];

describe('ProjectReportService.create — MANUAL late enqueue', () => {
  it('enqueues a late delivery when createdAt is at or past the deadline', async () => {
    // 19:30 Europe/Kyiv in winter == 17:30 UTC on 2026-02-10.
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:30:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).toHaveBeenCalledTimes(1);
    const call = late.enqueue.mock.calls[0][0] as {
      reportId: string;
      projectName: string;
      hours: number;
      isLate: boolean;
    };
    expect(call.reportId).toBe('r-1');
    expect(call.projectName).toBe('Proj');
    expect(call.hours).toBe(5);
    expect(call.isLate).toBe(true);
  });

  it('does NOT enqueue when createdAt is strictly before the deadline', async () => {
    const late = makeLateReports();
    // 14:00 Kyiv == 12:00 UTC on winter day.
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T12:00:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('18:59 Kyiv is NOT late (strictly before 19:00)', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      // 16:59 UTC in winter == 18:59 Kyiv
      createdAt: new Date('2026-02-10T16:59:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).not.toHaveBeenCalled();
  });

  it('19:00 Kyiv IS late (exactly at the deadline)', async () => {
    const late = makeLateReports();
    const prisma = makePrismaStub({
      createdAt: new Date('2026-02-10T17:00:00.000Z'),
      activeProfile: { timezone: 'Europe/Kyiv', dailyDigestAt: '19:00' },
    });
    const svc = new ProjectReportService(prisma as never, late);
    await svc.create(dto, ownerUser);
    expect(late.enqueue).toHaveBeenCalledTimes(1);
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

  it('no active DiscordProfile → no enqueue (even when createdAt would be late)', async () => {
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
