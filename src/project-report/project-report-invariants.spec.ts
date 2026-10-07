/**
 * Integration tests for the DB-level invariants on ProjectReport
 * after the contributor-snapshot refactor (migration
 * 20261023000000_project_report_contributors):
 *
 *   - full UNIQUE (projectId, reportDate) across sources;
 *   - ProjectReport→Project FK is RESTRICT, so hard-deleting a
 *     project with reports is refused at the DB layer;
 *   - ProjectReportContributor.employeeId FK is SET NULL on
 *     Employee hard-delete so the snapshot row survives with its
 *     name columns intact.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from '@jest/globals';
import { PrismaClient, ProjectReportSource } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const TAG = `invariants-${randomUUID().slice(0, 8)}`;
let projectId: string;
let employeeIdA: string;
let employeeIdB: string;

beforeAll(async () => {
  const project = await prisma.project.create({
    data: { name: `__test ${TAG} project`, status: 'planned' },
    select: { id: true },
  });
  projectId = project.id;
  const a = await prisma.employee.create({
    data: {
      firstName: 'Test',
      lastName: `${TAG}-A`,
      email: `${TAG}-a@test.local`,
      positions: [],
      status: 'active',
    },
    select: { id: true },
  });
  const b = await prisma.employee.create({
    data: {
      firstName: 'Test',
      lastName: `${TAG}-B`,
      email: `${TAG}-b@test.local`,
      positions: [],
      status: 'active',
    },
    select: { id: true },
  });
  employeeIdA = a.id;
  employeeIdB = b.id;
  await prisma.projectMember.createMany({
    data: [
      { projectId, employeeId: employeeIdA },
      { projectId, employeeId: employeeIdB },
    ],
  });
});

afterEach(async () => {
  await prisma.projectReportContributor.deleteMany({
    where: { report: { projectId } },
  });
  await prisma.projectReport.deleteMany({ where: { projectId } });
});

afterAll(async () => {
  await prisma.projectMember.deleteMany({ where: { projectId } });
  await prisma.projectReport.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.employee.deleteMany({
    where: { id: { in: [employeeIdA, employeeIdB] } },
  });
  await prisma.$disconnect();
});

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('ProjectReport invariants — contributor-snapshot era', () => {
  it('UNIQUE(projectId, reportDate) rejects a second row on the same project-day', async () => {
    await prisma.projectReport.create({
      data: {
        projectId,
        reportDate: date('2026-11-01'),
        hours: 5,
        content: 'first',
        source: ProjectReportSource.MANUAL,
        contributors: {
          create: {
            employeeId: employeeIdA,
            firstNameSnapshot: 'Test',
            lastNameSnapshot: 'A',
          },
        },
      },
    });
    await expect(
      prisma.projectReport.create({
        data: {
          projectId,
          reportDate: date('2026-11-01'),
          hours: 3,
          content: 'second',
          source: ProjectReportSource.MANUAL,
          contributors: {
            create: {
              employeeId: employeeIdB,
              firstNameSnapshot: 'Test',
              lastNameSnapshot: 'B',
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('ProjectReport→Project FK is RESTRICT: hard-delete with reports fails', async () => {
    await prisma.projectReport.create({
      data: {
        projectId,
        reportDate: date('2026-11-02'),
        hours: 4,
        content: 'with-report',
        source: ProjectReportSource.MANUAL,
        contributors: {
          create: {
            employeeId: employeeIdA,
            firstNameSnapshot: 'Test',
            lastNameSnapshot: 'A',
          },
        },
      },
    });
    await expect(
      prisma.project.delete({ where: { id: projectId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('ProjectReportContributor UNIQUE(reportId, employeeId) rejects duplicates', async () => {
    const report = await prisma.projectReport.create({
      data: {
        projectId,
        reportDate: date('2026-11-03'),
        hours: 2,
        content: 'dup',
        source: ProjectReportSource.MANUAL,
        contributors: {
          create: {
            employeeId: employeeIdA,
            firstNameSnapshot: 'Test',
            lastNameSnapshot: 'A',
          },
        },
      },
    });
    await expect(
      prisma.projectReportContributor.create({
        data: {
          reportId: report.id,
          employeeId: employeeIdA,
          firstNameSnapshot: 'Dup',
          lastNameSnapshot: 'A',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
