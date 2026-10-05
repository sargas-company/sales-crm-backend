/* eslint-disable no-console */
/**
 * Discord safe-disable utility.
 *
 * Puts every DiscordProfile into a known-safe shape:
 *   - active = false
 *   - reportsEnabled / birthdaysEnabled / absencesEnabled / weeklyEnabled = false
 *
 * Nothing else is touched (channel/role ids, timezone, schedules are
 * preserved so an operator can re-enable later without re-entering
 * the configuration).
 *
 * Dry-run by default; use `--apply` to persist. Running this on a
 * freshly-restored production DB immediately after cutover is the
 * supported way to make sure the scheduler cannot send a single
 * message until the owner explicitly re-activates.
 *
 *   npx ts-node scripts/discord-safe-disable.ts             # dry-run
 *   npx ts-node scripts/discord-safe-disable.ts --apply     # perform
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export const SAFE_DISABLED_FIELDS = {
  active: false,
  reportsEnabled: false,
  birthdaysEnabled: false,
  absencesEnabled: false,
  weeklyEnabled: false,
} as const;

type MinimalDb = Pick<PrismaClient, 'discordProfile'>;

export interface DisablePlan {
  mode: 'dry-run' | 'apply';
  totalProfiles: number;
  totalChanges: number;
  planned: Array<{
    name: string;
    changes: Record<keyof typeof SAFE_DISABLED_FIELDS, { from: boolean; to: boolean } | null>;
  }>;
  rowsUpdated?: number;
  after?: Array<Record<string, boolean | string>>;
}

/**
 * Pure, testable core. Does not read process.argv or print.
 */
export async function disableAllProfiles(
  prisma: MinimalDb,
  opts: { apply: boolean },
): Promise<DisablePlan> {
  const profiles = await prisma.discordProfile.findMany({
    select: {
      id: true,
      name: true,
      active: true,
      reportsEnabled: true,
      birthdaysEnabled: true,
      absencesEnabled: true,
      weeklyEnabled: true,
    },
    orderBy: { name: 'asc' },
  });

  const planned = profiles.map((p) => {
    const changes = {
      active: p.active ? { from: true, to: false } : null,
      reportsEnabled: p.reportsEnabled ? { from: true, to: false } : null,
      birthdaysEnabled: p.birthdaysEnabled ? { from: true, to: false } : null,
      absencesEnabled: p.absencesEnabled ? { from: true, to: false } : null,
      weeklyEnabled: p.weeklyEnabled ? { from: true, to: false } : null,
    };
    return { name: p.name as string, changes };
  });
  const totalChanges = planned.reduce(
    (acc, p) =>
      acc + Object.values(p.changes).filter((v) => v !== null).length,
    0,
  );

  if (!opts.apply) {
    return {
      mode: 'dry-run',
      totalProfiles: profiles.length,
      totalChanges,
      planned,
    };
  }

  const res = await prisma.discordProfile.updateMany({
    data: { ...SAFE_DISABLED_FIELDS },
  });
  const after = await prisma.discordProfile.findMany({
    select: {
      name: true,
      active: true,
      reportsEnabled: true,
      birthdaysEnabled: true,
      absencesEnabled: true,
      weeklyEnabled: true,
    },
    orderBy: { name: 'asc' },
  });
  return {
    mode: 'apply',
    totalProfiles: profiles.length,
    totalChanges,
    planned,
    rowsUpdated: res.count,
    after: after as unknown as DisablePlan['after'],
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const result = await disableAllProfiles(prisma, { apply });
    const hint = apply
      ? undefined
      : 'Re-run with --apply to persist.';
    console.log(
      JSON.stringify({ ...result, ...(hint ? { hint } : {}) }, null, 2),
    );
  } catch (err) {
    console.error('[discord-safe-disable] failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main();
}
