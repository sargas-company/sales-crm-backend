/**
 * Service-level tests for the cross-source invariant:
 *   - MANUAL exists → DISCORD create is rejected with 409.
 *   - DISCORD exists → MANUAL create is rejected with 409.
 *   - Concurrent DISCORD creates for the same (project, date) → exactly
 *     one wins; the loser gets 409 (never a crash and never two rows).
 *
 * Talks to the live local Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaClient, ProjectReportSource } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { ProjectReportService } from '../project-report/project-report.service';
import { DiscordReportService } from './discord-report.service';
import type { DiscordLateReportService } from './discord-late-report.service';

const prisma = new PrismaClient();
const prismaSvc = prisma as unknown as PrismaService;
const noopLateReports = {
  enqueue: () => Promise.resolve(),
  tick: () => Promise.resolve(),
} as unknown as DiscordLateReportService;

const discord = new DiscordReportService(prismaSvc, noopLateReports);
const manual = new ProjectReportService(prismaSvc, noopLateReports);

const TAG = `cross-${randomUUID().slice(0, 8)}`;
let projectId: string;
let projectDiscordChannelId: string;
let employeeId: string;
let userId: string;

beforeAll(async () => {
  projectDiscordChannelId = String(
    10_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
  );
  const project = await prisma.project.create({
    data: {
      name: `__test ${TAG}`,
      status: 'planned',
      discordChannelId: projectDiscordChannelId,
    },
    select: { id: true },
  });
  projectId = project.id;
  const emp = await prisma.employee.create({
    data: {
      firstName: 'E',
      lastName: TAG,
      email: `${TAG}-emp@test.local`,
      positions: [],
      status: 'active',
    },
    select: { id: true },
  });
  employeeId = emp.id;
  userId = ''; // not used; AuthUser only needs { id, permissions }.
  await prisma.projectMember.create({ data: { projectId, employeeId } });
});

afterAll(async () => {
  await prisma.projectReport.deleteMany({ where: { projectId } });
  await prisma.projectMember.deleteMany({ where: { projectId } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.employee.delete({ where: { id: employeeId } });
  await prisma.$disconnect();
});

// Minimal AuthUser — only `permissions` is consulted by the service's
// collision path, and `projects:view_any` bypasses the per-employee
// author-scope check.
function authUser() {
  return {
    id: 'test-user',
    permissions: new Set(['projects:view_any']),
  };
}

describe('one-report-per-project-day invariant', () => {
  it('MANUAL first → DISCORD create rejected (409)', async () => {
    const date = '2027-01-10';
    const u = authUser();
    await manual.create(
      {
        projectId,
        reportDate: date,
        hours: 2,
        content: 'manual-first',
      } as Parameters<typeof manual.create>[0],
      u,
    );
    await expect(
      discord.createFromDiscord({
        discordChannelId: projectDiscordChannelId,
        discordUserId: '111111111111111111',
        discordUsername: 'alice',
        hours: 1,
        text: 'discord-after',
        now: new Date(`${date}T12:00:00+03:00`),
        cutoffHour: 10,
        dailyDigestAt: '19:00',
        timezone: 'Europe/Kyiv',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('DISCORD first → MANUAL create rejected (409)', async () => {
    const date = '2027-01-11';
    await discord.createFromDiscord({
      discordChannelId: projectDiscordChannelId,
      discordUserId: '222222222222222222',
      discordUsername: 'bob',
      hours: 3,
      text: 'discord-first',
      now: new Date(`${date}T12:00:00+03:00`),
      cutoffHour: 10,
      dailyDigestAt: '19:00',
      timezone: 'Europe/Kyiv',
    });
    const u = authUser();
    await expect(
      manual.create(
        {
          projectId,
          reportDate: date,
          hours: 5,
          content: 'manual-after',
        } as Parameters<typeof manual.create>[0],
        u,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('concurrent DISCORD create for the same (project, date)', () => {
  it('exactly one wins', async () => {
    const date = '2027-01-12';
    const now = new Date(`${date}T12:00:00+03:00`);
    const results = await Promise.allSettled([
      discord.createFromDiscord({
        discordChannelId: projectDiscordChannelId,
        discordUserId: '333333333333333333',
        discordUsername: 'c-one',
        hours: 1,
        text: 'first',
        now,
        cutoffHour: 10,
        dailyDigestAt: '19:00',
        timezone: 'Europe/Kyiv',
      }),
      discord.createFromDiscord({
        discordChannelId: projectDiscordChannelId,
        discordUserId: '444444444444444444',
        discordUsername: 'c-two',
        hours: 2,
        text: 'second',
        now,
        cutoffHour: 10,
        dailyDigestAt: '19:00',
        timezone: 'Europe/Kyiv',
      }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    const err = (lost[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ConflictException);
    // Only one row actually in DB.
    const count = await prisma.projectReport.count({
      where: {
        projectId,
        reportDate: new Date(`${date}T00:00:00.000Z`),
        source: ProjectReportSource.DISCORD,
      },
    });
    expect(count).toBe(1);
  });
});
