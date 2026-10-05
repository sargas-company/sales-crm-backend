/**
 * Integration tests for the DB-level invariants on ProjectReport:
 *   - CHECK constraint `ProjectReport_source_shape_chk`
 *   - partial unique index `ProjectReport_manual_uq`
 *   - partial unique index `ProjectReport_discord_uq`
 *
 * These talk to the live local Postgres (localhost:5433/ai_dashboard).
 * Each test seeds and cleans up its own rows under a unique prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
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
});

afterAll(async () => {
  await prisma.projectReport.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.employee.deleteMany({
    where: { id: { in: [employeeIdA, employeeIdB] } },
  });
  await prisma.$disconnect();
});

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('ProjectReport_source_shape_chk', () => {
  it('MANUAL requires non-null employeeId and null discord fields', async () => {
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectReport" (id, "projectId", "employeeId", "reportDate", hours, content, source, "discordUserId", "updatedAt")
       VALUES ($1,$2,NULL,$3::date,1,'x','MANUAL',NULL,now())`,
      randomUUID(),
      projectId,
      '2026-01-01',
    );
    await expect(bad).rejects.toThrow(/source_shape_chk|violates check constraint/);
  });

  it('MANUAL rejects a non-null discordUserId', async () => {
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectReport" (id, "projectId", "employeeId", "reportDate", hours, content, source, "discordUserId", "updatedAt")
       VALUES ($1,$2,$3,$4::date,1,'x','MANUAL','123456789012345678',now())`,
      randomUUID(),
      projectId,
      employeeIdA,
      '2026-01-02',
    );
    await expect(bad).rejects.toThrow(/source_shape_chk|violates check constraint/);
  });

  it('DISCORD requires null employeeId and non-null discordUserId', async () => {
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectReport" (id, "projectId", "employeeId", "reportDate", hours, content, source, "discordUserId", "updatedAt")
       VALUES ($1,$2,$3,$4::date,1,'x','DISCORD','123456789012345678',now())`,
      randomUUID(),
      projectId,
      employeeIdA,
      '2026-01-03',
    );
    await expect(bad).rejects.toThrow(/source_shape_chk|violates check constraint/);
  });

  it('DISCORD rejects a null discordUserId', async () => {
    const bad = prisma.$executeRawUnsafe(
      `INSERT INTO "ProjectReport" (id, "projectId", "employeeId", "reportDate", hours, content, source, "discordUserId", "updatedAt")
       VALUES ($1,$2,NULL,$3::date,1,'x','DISCORD',NULL,now())`,
      randomUUID(),
      projectId,
      '2026-01-04',
    );
    await expect(bad).rejects.toThrow(/source_shape_chk|violates check constraint/);
  });
});

describe('ProjectReport partial unique indexes', () => {
  it('MANUAL — second row for same (project, employee, date) is rejected', async () => {
    const date = day('2026-02-01');
    await prisma.projectReport.create({
      data: {
        projectId,
        employeeId: employeeIdA,
        reportDate: date,
        hours: 1,
        content: 'first',
        source: ProjectReportSource.MANUAL,
      },
    });
    await expect(
      prisma.projectReport.create({
        data: {
          projectId,
          employeeId: employeeIdA,
          reportDate: date,
          hours: 2,
          content: 'dup',
          source: ProjectReportSource.MANUAL,
        },
      }),
    ).rejects.toThrow();
  });

  it('MANUAL — different employee on same (project, date) is allowed', async () => {
    const date = day('2026-02-02');
    await prisma.projectReport.create({
      data: {
        projectId,
        employeeId: employeeIdA,
        reportDate: date,
        hours: 1,
        content: 'A',
        source: ProjectReportSource.MANUAL,
      },
    });
    await expect(
      prisma.projectReport.create({
        data: {
          projectId,
          employeeId: employeeIdB,
          reportDate: date,
          hours: 1,
          content: 'B',
          source: ProjectReportSource.MANUAL,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('DISCORD — second row for same (project, date) is rejected', async () => {
    const date = day('2026-02-03');
    await prisma.projectReport.create({
      data: {
        projectId,
        reportDate: date,
        hours: 1,
        content: 'first',
        source: ProjectReportSource.DISCORD,
        discordUserId: '123456789012345678',
        discordUsername: 'alice',
      },
    });
    await expect(
      prisma.projectReport.create({
        data: {
          projectId,
          reportDate: date,
          hours: 2,
          content: 'dup',
          source: ProjectReportSource.DISCORD,
          discordUserId: '234567890123456789',
          discordUsername: 'bob',
        },
      }),
    ).rejects.toThrow();
  });
});
