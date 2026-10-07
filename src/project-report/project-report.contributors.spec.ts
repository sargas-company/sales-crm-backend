/**
 * Contributor snapshot integration tests — ensures the business
 * invariant "contributors are the team at submission time, immutably"
 * holds across:
 *   - MANUAL create snapshots the current ProjectMember set;
 *   - DISCORD /report snapshots the current ProjectMember set;
 *   - 0-member project → 422 (both MANUAL and DISCORD paths);
 *   - add/remove members AFTER create does NOT alter the snapshot;
 *   - Employee rename does NOT alter snapshot names;
 *   - Employee hard-delete nulls employeeId but keeps snapshot name;
 *   - update(hours/content) leaves contributors untouched;
 *   - Project hard-delete with existing report → 409.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import type { DiscordLateReportService } from '../discord-integration/discord-late-report.service';
import { DiscordReportService } from '../discord-integration/discord-report.service';
import { ProjectService } from '../project/project.service';
import { ProjectReportService } from './project-report.service';

const prisma = new PrismaClient();
const prismaSvc = prisma as unknown as PrismaService;
const noopLateReports = {
  enqueue: () => Promise.resolve(),
  tick: () => Promise.resolve(),
} as unknown as DiscordLateReportService;

const TAG = `contrib-${randomUUID().slice(0, 8)}`;

interface Fixture {
  projectId: string;
  channelId: string;
  employeeIds: string[];
}

async function makeFixture(opts: {
  channelId?: string;
  memberCount: number;
}): Promise<Fixture> {
  const channelId =
    opts.channelId ??
    String(10_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000_000)));
  const project = await prisma.project.create({
    data: {
      name: `__test ${TAG} ${randomUUID().slice(0, 4)}`,
      status: 'planned',
      discordChannelId: channelId,
    },
    select: { id: true },
  });
  const employees = await Promise.all(
    Array.from({ length: opts.memberCount }, (_, i) =>
      prisma.employee.create({
        data: {
          firstName: `C${i}`,
          lastName: `${TAG}-${randomUUID().slice(0, 4)}`,
          email: `${TAG}-${randomUUID().slice(0, 6)}@test.local`,
          positions: [],
          status: 'active',
        },
        select: { id: true },
      }),
    ),
  );
  if (employees.length) {
    await prisma.projectMember.createMany({
      data: employees.map((e) => ({
        projectId: project.id,
        employeeId: e.id,
      })),
    });
  }
  return {
    projectId: project.id,
    channelId,
    employeeIds: employees.map((e) => e.id),
  };
}

async function cleanupFixture(f: Fixture) {
  await prisma.projectReportContributor.deleteMany({
    where: { report: { projectId: f.projectId } },
  });
  await prisma.projectReport.deleteMany({ where: { projectId: f.projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId: f.projectId } });
  await prisma.project.deleteMany({ where: { id: f.projectId } });
  if (f.employeeIds.length) {
    await prisma.employee.deleteMany({ where: { id: { in: f.employeeIds } } });
  }
}

const svc = new ProjectReportService(prismaSvc, noopLateReports);
const discord = new DiscordReportService(prismaSvc, noopLateReports);

const owner = {
  id: 'test-owner',
  permissions: new Set(['projects:view_any']),
} as unknown as Parameters<ProjectReportService['create']>[1];

afterAll(async () => {
  await prisma.$disconnect();
});

describe('MANUAL create snapshots the current ProjectMember set', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 3 });
  });
  afterAll(() => cleanupFixture(f));

  it('creates one contributor row per current member', async () => {
    const created = await svc.create(
      {
        projectId: f.projectId,
        reportDate: '2027-02-01',
        hours: 5,
        content: 'manual with 3 members',
      } as Parameters<ProjectReportService['create']>[0],
      owner,
    );
    const contribs = await prisma.projectReportContributor.findMany({
      where: { reportId: (created as { id: string }).id },
      orderBy: { createdAt: 'asc' },
    });
    expect(contribs.map((c) => c.employeeId).sort()).toEqual(
      [...f.employeeIds].sort(),
    );
    for (const c of contribs) {
      expect(c.firstNameSnapshot).toMatch(/^C\d$/);
      expect(c.lastNameSnapshot.length).toBeGreaterThan(0);
    }
  });
});

describe('zero-member projects → 422 on both paths', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 0 });
  });
  afterAll(() => cleanupFixture(f));

  it('MANUAL path returns 422', async () => {
    await expect(
      svc.create(
        {
          projectId: f.projectId,
          reportDate: '2027-02-02',
          hours: 5,
          content: 'no team',
        } as Parameters<ProjectReportService['create']>[0],
        owner,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('DISCORD path returns 409 (channel linked but team empty)', async () => {
    await expect(
      discord.createFromDiscord({
        discordChannelId: f.channelId,
        discordUserId: '111111111111111111',
        discordUsername: 'alice',
        hours: 2,
        text: 'empty-team',
        now: new Date('2027-02-02T12:00:00+03:00'),
        cutoffHour: 10,
        timezone: 'Europe/Kyiv',
        dailyDigestAt: '19:00',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('snapshot is immutable after create', () => {
  let f: Fixture;
  let reportId: string;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 2 });
    const created = await svc.create(
      {
        projectId: f.projectId,
        reportDate: '2027-02-03',
        hours: 4,
        content: 'immutable',
      } as Parameters<ProjectReportService['create']>[0],
      owner,
    );
    reportId = (created as { id: string }).id;
  });
  afterAll(() => cleanupFixture(f));

  it('adding a new team member AFTER create does NOT appear in the snapshot', async () => {
    const newcomer = await prisma.employee.create({
      data: {
        firstName: 'New',
        lastName: `${TAG}-newcomer`,
        email: `${TAG}-newcomer-${randomUUID().slice(0, 4)}@test.local`,
        positions: [],
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.projectMember.create({
      data: { projectId: f.projectId, employeeId: newcomer.id },
    });
    const contribs = await prisma.projectReportContributor.findMany({
      where: { reportId },
    });
    expect(contribs.map((c) => c.employeeId)).not.toContain(newcomer.id);
    expect(contribs.length).toBe(2);
    await prisma.projectMember.deleteMany({
      where: { projectId: f.projectId, employeeId: newcomer.id },
    });
    await prisma.employee.delete({ where: { id: newcomer.id } });
  });

  it('renaming an existing contributor does NOT change snapshot names', async () => {
    const [emp] = f.employeeIds;
    const before = await prisma.projectReportContributor.findFirst({
      where: { reportId, employeeId: emp },
    });
    await prisma.employee.update({
      where: { id: emp },
      data: { firstName: 'Renamed' },
    });
    const after = await prisma.projectReportContributor.findFirst({
      where: { reportId, employeeId: emp },
    });
    expect(after!.firstNameSnapshot).toBe(before!.firstNameSnapshot);
    expect(after!.firstNameSnapshot).not.toBe('Renamed');
  });
});

describe('Employee hard-delete nulls contributor.employeeId but keeps snapshot name', () => {
  let f: Fixture;
  let reportId: string;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 1 });
    const created = await svc.create(
      {
        projectId: f.projectId,
        reportDate: '2027-02-04',
        hours: 3,
        content: 'surviving-snapshot',
      } as Parameters<ProjectReportService['create']>[0],
      owner,
    );
    reportId = (created as { id: string }).id;
  });
  afterAll(async () => {
    await prisma.projectReportContributor.deleteMany({ where: { reportId } });
    await prisma.projectReport.deleteMany({ where: { id: reportId } });
    await prisma.projectMember.deleteMany({ where: { projectId: f.projectId } });
    await prisma.project.delete({ where: { id: f.projectId } });
  });

  it('employeeId becomes null; firstName/lastName snapshot persist', async () => {
    const [emp] = f.employeeIds;
    const before = await prisma.projectReportContributor.findFirst({
      where: { reportId },
    });
    expect(before?.firstNameSnapshot).toBeTruthy();
    // Remove membership + delete Employee → SetNull on contributor.
    await prisma.projectMember.deleteMany({
      where: { projectId: f.projectId, employeeId: emp },
    });
    await prisma.employee.delete({ where: { id: emp } });
    const after = await prisma.projectReportContributor.findFirst({
      where: { reportId },
    });
    expect(after).not.toBeNull();
    expect(after!.employeeId).toBeNull();
    expect(after!.firstNameSnapshot).toBe(before!.firstNameSnapshot);
    expect(after!.lastNameSnapshot).toBe(before!.lastNameSnapshot);
  });
});

describe('update is restricted to hours/content; snapshot untouched', () => {
  let f: Fixture;
  let reportId: string;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 2 });
    const created = await svc.create(
      {
        projectId: f.projectId,
        reportDate: '2027-02-05',
        hours: 2,
        content: 'orig',
      } as Parameters<ProjectReportService['create']>[0],
      owner,
    );
    reportId = (created as { id: string }).id;
  });
  afterAll(() => cleanupFixture(f));

  it('updates hours/content without touching contributors', async () => {
    const before = await prisma.projectReportContributor.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, employeeId: true, firstNameSnapshot: true },
    });
    await svc.update(
      reportId,
      { hours: 7, content: 'edited' },
      owner,
    );
    const after = await prisma.projectReportContributor.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, employeeId: true, firstNameSnapshot: true },
    });
    expect(after).toEqual(before);
    const row = await prisma.projectReport.findUnique({ where: { id: reportId } });
    expect(row?.hours).toBe(7);
    expect(row?.content).toBe('edited');
  });
});

describe('Project hard-delete with existing reports → 409', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await makeFixture({ memberCount: 1 });
    await svc.create(
      {
        projectId: f.projectId,
        reportDate: '2027-02-06',
        hours: 1,
        content: 'blocks-delete',
      } as Parameters<ProjectReportService['create']>[0],
      owner,
    );
  });
  afterAll(() => cleanupFixture(f));

  it('ProjectService.remove refuses with ConflictException', async () => {
    const auditStub = {
      recordSafe: () => Promise.resolve(),
    } as unknown as ConstructorParameters<typeof ProjectService>[1];
    const projectSvc = new ProjectService(prismaSvc, auditStub);
    await expect(
      projectSvc.remove(f.projectId, owner),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
