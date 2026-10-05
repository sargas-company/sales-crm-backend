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

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
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
    const planned = profiles.map((p) => ({
      name: p.name,
      changes: {
        active: p.active ? { from: true, to: false } : null,
        reportsEnabled: p.reportsEnabled ? { from: true, to: false } : null,
        birthdaysEnabled: p.birthdaysEnabled ? { from: true, to: false } : null,
        absencesEnabled: p.absencesEnabled ? { from: true, to: false } : null,
        weeklyEnabled: p.weeklyEnabled ? { from: true, to: false } : null,
      },
    }));
    const totalChanges = planned.reduce(
      (acc, p) => acc + Object.values(p.changes).filter((v) => v !== null).length,
      0,
    );

    if (!apply) {
      console.log(
        JSON.stringify(
          {
            mode: 'dry-run',
            totalProfiles: profiles.length,
            totalChanges,
            planned,
            hint: 'Re-run with --apply to persist.',
          },
          null,
          2,
        ),
      );
      return;
    }

    const result = await prisma.discordProfile.updateMany({
      data: {
        active: false,
        reportsEnabled: false,
        birthdaysEnabled: false,
        absencesEnabled: false,
        weeklyEnabled: false,
      },
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
    console.log(
      JSON.stringify({ mode: 'apply', rowsUpdated: result.count, after }, null, 2),
    );
  } catch (err) {
    console.error('[discord-safe-disable] failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
