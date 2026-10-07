/**
 * `ProjectReport_source_shape_chk` regression — the follow-up CHECK
 * from migration 20261024000000 pins Discord-provenance columns to
 * the DISCORD source. It must reject:
 *   - MANUAL rows carrying a Discord user id;
 *   - MANUAL rows carrying a Discord username;
 *   - DISCORD rows missing a Discord user id (even if username is
 *     set — the user id is the stable snowflake identity).
 *
 * And it must accept:
 *   - MANUAL rows with both Discord columns NULL;
 *   - DISCORD rows with a user id (username may be null).
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
const TAG = `source-shape-${randomUUID().slice(0, 8)}`;

let projectId: string;
let employeeId: string;

const CHK = /ProjectReport_source_shape_chk/;

beforeAll(async () => {
  const project = await prisma.project.create({
    data: { name: `__test ${TAG}`, status: 'planned' },
    select: { id: true },
  });
  projectId = project.id;
  const emp = await prisma.employee.create({
    data: {
      firstName: 'Shape',
      lastName: TAG,
      email: `${TAG}@test.local`,
      positions: [],
      status: 'active',
    },
    select: { id: true },
  });
  employeeId = emp.id;
  await prisma.projectMember.create({ data: { projectId, employeeId } });
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
  await prisma.employee.delete({ where: { id: employeeId } });
  await prisma.$disconnect();
});

function manualBase(reportDate: string) {
  return {
    projectId,
    reportDate: new Date(`${reportDate}T00:00:00.000Z`),
    hours: 2,
    content: 'shape-test',
    source: ProjectReportSource.MANUAL,
    contributors: {
      create: {
        employeeId,
        firstNameSnapshot: 'Shape',
        lastNameSnapshot: TAG,
      },
    },
  };
}

function discordBase(reportDate: string) {
  return {
    projectId,
    reportDate: new Date(`${reportDate}T00:00:00.000Z`),
    hours: 3,
    content: 'shape-test-discord',
    source: ProjectReportSource.DISCORD,
    discordUserId: '111111111111111111',
    discordUsername: 'alice',
    contributors: {
      create: {
        employeeId,
        firstNameSnapshot: 'Shape',
        lastNameSnapshot: TAG,
      },
    },
  };
}

describe('ProjectReport_source_shape_chk — rejects', () => {
  it('MANUAL + discordUserId → CHECK fail', async () => {
    await expect(
      prisma.projectReport.create({
        data: {
          ...manualBase('2027-04-01'),
          discordUserId: '222222222222222222',
        },
      }),
    ).rejects.toThrow(CHK);
  });

  it('MANUAL + discordUsername → CHECK fail', async () => {
    await expect(
      prisma.projectReport.create({
        data: {
          ...manualBase('2027-04-02'),
          discordUsername: 'bob',
        },
      }),
    ).rejects.toThrow(CHK);
  });

  it('DISCORD + null discordUserId → CHECK fail', async () => {
    await expect(
      prisma.projectReport.create({
        data: {
          ...discordBase('2027-04-03'),
          discordUserId: null,
        },
      }),
    ).rejects.toThrow(CHK);
  });
});

describe('ProjectReport_source_shape_chk — accepts', () => {
  it('clean MANUAL (both Discord columns NULL) → success', async () => {
    const row = await prisma.projectReport.create({
      data: manualBase('2027-04-04'),
      select: { id: true, source: true },
    });
    expect(row.source).toBe(ProjectReportSource.MANUAL);
  });

  it('clean DISCORD (user id set, username may be set or null) → success', async () => {
    const withName = await prisma.projectReport.create({
      data: discordBase('2027-04-05'),
      select: { id: true, source: true },
    });
    expect(withName.source).toBe(ProjectReportSource.DISCORD);
    const withoutName = await prisma.projectReport.create({
      data: {
        ...discordBase('2027-04-06'),
        discordUsername: null,
      },
      select: { id: true, source: true },
    });
    expect(withoutName.source).toBe(ProjectReportSource.DISCORD);
  });
});
