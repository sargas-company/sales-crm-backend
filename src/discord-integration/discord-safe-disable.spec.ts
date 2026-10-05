/**
 * Regression test for the `discord-safe-disable` cutover utility.
 *
 * Writes-against-the-local-Postgres style — matches the pattern used
 * by project-report-invariants.spec.ts and
 * discord-report-cross-source.spec.ts. We flip BOTH profiles into
 * active + all toggles enabled, snapshot the DB, run the script in
 * dry-run and confirm nothing moved, then run with --apply and
 * confirm the known-safe shape and restore the pre-test state.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from '@jest/globals';
import { PrismaClient } from '@prisma/client';

import { disableAllProfiles } from '../../scripts/discord-safe-disable';

const prisma = new PrismaClient();

async function snapshot() {
  return (
    await prisma.discordProfile.findMany({
      select: {
        name: true,
        active: true,
        reportsEnabled: true,
        birthdaysEnabled: true,
        absencesEnabled: true,
        weeklyEnabled: true,
      },
      orderBy: { name: 'asc' },
    })
  ).reduce<Record<string, Record<string, boolean>>>((acc, p) => {
    acc[p.name] = {
      active: p.active,
      reportsEnabled: p.reportsEnabled,
      birthdaysEnabled: p.birthdaysEnabled,
      absencesEnabled: p.absencesEnabled,
      weeklyEnabled: p.weeklyEnabled,
    };
    return acc;
  }, {});
}

const PROFILES = ['TEST', 'PRODUCTION'] as const;

type Original = Awaited<ReturnType<typeof snapshot>>;
let original: Original;

beforeAll(async () => {
  original = await snapshot();
  // Force both profiles into the loudest possible state so the test
  // asserts the shape of what disable produces.
  await prisma.discordProfile.updateMany({
    data: {
      active: true,
      reportsEnabled: true,
      birthdaysEnabled: true,
      absencesEnabled: true,
      weeklyEnabled: true,
    },
  });
});

afterEach(async () => {
  // Re-arm after `apply` so the next test starts from "all enabled".
  await prisma.discordProfile.updateMany({
    data: {
      active: true,
      reportsEnabled: true,
      birthdaysEnabled: true,
      absencesEnabled: true,
      weeklyEnabled: true,
    },
  });
});

afterAll(async () => {
  // Restore the pre-test state exactly.
  for (const [name, fields] of Object.entries(original)) {
    await prisma.discordProfile.update({
      where: { name: name as (typeof PROFILES)[number] },
      data: fields,
    });
  }
  await prisma.$disconnect();
});

describe('discord-safe-disable', () => {
  it('dry-run reports planned changes and does NOT touch the DB', async () => {
    const before = await snapshot();
    const plan = await disableAllProfiles(prisma, { apply: false });

    expect(plan.mode).toBe('dry-run');
    expect(plan.totalProfiles).toBe(2);
    // Both profiles were "loud" → 5 changes each → 10 total.
    expect(plan.totalChanges).toBe(10);
    const names = plan.planned.map((p) => p.name).sort();
    expect(names).toEqual(['PRODUCTION', 'TEST']);

    const after = await snapshot();
    expect(after).toEqual(before); // zero DB mutation
  });

  it('--apply disables both profiles and nulls every automation toggle', async () => {
    const result = await disableAllProfiles(prisma, { apply: true });
    expect(result.mode).toBe('apply');
    expect(result.rowsUpdated).toBe(2);

    const after = await snapshot();
    for (const name of PROFILES) {
      expect(after[name]).toEqual({
        active: false,
        reportsEnabled: false,
        birthdaysEnabled: false,
        absencesEnabled: false,
        weeklyEnabled: false,
      });
    }
  });
});
