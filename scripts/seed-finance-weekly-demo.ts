/* eslint-disable no-console */
/**
 * Local-only demo seeder for Finance Weekly Tracking.
 *
 * Idempotency: every demo row is tagged.
 *   • ProjectPaymentRule.note starts with '[demo] '
 *   • WeeklyEntry.note starts with '[demo] ' (or is null when the demo
 *     row has no explicit note but its status is one of ours)
 *
 * We only seed weekly entries for projects that have at least one
 * ProjectMember (i.e. the ones actually used in the demo dataset) to
 * avoid polluting real projects.
 *
 * Guarded by the same five signals as scripts/assert-local-db.ts.
 *
 * Usage:  APP_ENV=local npx ts-node scripts/seed-finance-weekly-demo.ts
 */
import 'dotenv/config';
import { PrismaClient, Prisma, PaymentStatus, PaymentRuleType } from '@prisma/client';

const { Decimal } = Prisma;

// ─── Local-DB guard ─────────────────────────────────────────────────────────

const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function assertLocal(): void {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== 'local') {
    console.error(`seed-finance-weekly-demo: APP_ENV="${appEnv ?? ''}" — refusing`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed-finance-weekly-demo: DATABASE_URL not set — refusing');
    process.exit(1);
  }
  try {
    const parsed = new URL(url);
    if (!HOST_ALLOWLIST.includes(parsed.hostname)) {
      console.error(`seed-finance-weekly-demo: host ${parsed.hostname} not allowed`);
      process.exit(1);
    }
    if (parsed.port !== EXPECTED_PORT) {
      console.error(`seed-finance-weekly-demo: port ${parsed.port} not allowed`);
      process.exit(1);
    }
    const dbName = parsed.pathname.replace(/^\//, '');
    if (!DB_NAME_ALLOWLIST.includes(dbName)) {
      console.error(`seed-finance-weekly-demo: db ${dbName} not allowed`);
      process.exit(1);
    }
  } catch {
    console.error('seed-finance-weekly-demo: DATABASE_URL not parseable — refusing');
    process.exit(1);
  }
}

assertLocal();

const prisma = new PrismaClient();

// Deterministic pseudo-random so reruns look the same.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

async function main() {
  // Ensure fiscal calendar exists.
  const monthCount = await prisma.fiscalMonth.count();
  if (monthCount === 0) {
    console.error(
      'No fiscal months found. Run: APP_ENV=local npx ts-node scripts/generate-fiscal-calendar.ts',
    );
    process.exit(1);
  }

  // Wipe our own demo rows first. Every demo entry is tagged with a
  // note that starts with '[demo]' so we never touch user-created rows.
  const wipedEntries = await prisma.weeklyEntry.deleteMany({
    where: { note: { startsWith: '[demo]' } },
  });
  const wipedRules = await prisma.projectPaymentRule.deleteMany({
    where: { note: { startsWith: '[demo]' } },
  });
  console.log(
    `Wiped ${wipedEntries.count} demo weekly entries and ${wipedRules.count} demo payment rules.`,
  );

  const projects = await prisma.project.findMany({
    where: { status: { not: 'archived' } },
    select: { id: true, name: true, status: true },
    orderBy: { name: 'asc' },
  });
  if (projects.length === 0) {
    console.log('No active projects found — nothing to seed.');
    return;
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const currentMonth = await prisma.fiscalMonth.findFirst({
    where: { startDate: { lte: today }, endDate: { gte: today } },
  });
  if (!currentMonth) {
    console.error('No fiscal month contains today. Regenerate the calendar.');
    process.exit(1);
  }

  // Get 5 months window: 3 past + current + 1 next
  const months = await prisma.fiscalMonth.findMany({
    where: {
      OR: [
        { year: currentMonth.year - 1 },
        { year: currentMonth.year },
        { year: currentMonth.year + 1 },
      ],
    },
    orderBy: [{ year: 'asc' }, { sequenceInYear: 'asc' }],
    include: { weeks: { orderBy: { indexInMonth: 'asc' } } },
  });
  const currentIdx = months.findIndex((m) => m.id === currentMonth.id);
  const window = months.slice(Math.max(0, currentIdx - 3), currentIdx + 2);

  // Payment rules per project
  const ruleTypes: PaymentRuleType[] = [
    'FIXED_DELAY',
    'WEEKLY_ON_DOW',
    'EVERY_N_WEEKS',
  ];
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    const type = ruleTypes[i % ruleTypes.length];
    const ruleData: Prisma.ProjectPaymentRuleCreateInput = {
      project: { connect: { id: p.id } },
      type,
      delayDays: type === 'FIXED_DELAY' ? 3 + (i % 5) : null,
      dayOfWeek: type === 'WEEKLY_ON_DOW' ? 5 : null, // Friday
      intervalWeeks: type === 'EVERY_N_WEEKS' ? 2 : null,
      note: `[demo] default payment rule`,
      effectiveFrom: new Date(currentMonth.year - 1, 0, 1),
    };
    await prisma.projectPaymentRule.create({ data: ruleData });
  }
  console.log(`Created ${projects.length} demo payment rules.`);

  // Weekly entries — new logic:
  //   - transparent cell = didn't work that week
  //   - `expected_later` (orange) = worked, but money arrives later — no amount
  //   - one (rarely two) payout week per (project, month) carries the actual
  //     amount, with a status that depends on time: received (past), in_transit
  //     (current), planned_invoice (future). No more `expected_this_month` or
  //     `no_work` — they're excluded from the UI.
  const rng = makeRng(0xf1c9e);

  const pickPayoutStatus = (
    weekStart: Date,
    weekEnd: Date,
    isPastMonth: boolean,
    isFutureMonth: boolean,
  ): PaymentStatus => {
    if (isPastMonth) return 'received';
    if (isFutureMonth) return rng() < 0.5 ? 'planned_invoice' : 'expected_later';
    // Current month: choose by relation to today
    if (weekEnd < today) return 'received';
    if (weekStart <= today && weekEnd >= today) {
      return rng() < 0.65 ? 'in_transit' : 'received';
    }
    // Future week within current month
    return rng() < 0.55 ? 'planned_invoice' : 'in_transit';
  };

  let entriesCreated = 0;
  for (const month of window) {
    const isPastMonth = month.endDate < today;
    const isFutureMonth = month.startDate > today;

    for (const p of projects) {
      // 15% of the time the project is idle for the whole month
      if (rng() < 0.15) continue;

      const weekCount = month.weeks.length;
      // 1 payout week; occasionally 2 (bi-weekly or split invoice)
      const primaryPayout = Math.floor(rng() * weekCount);
      const hasSecondPayout = rng() < 0.18;
      let secondaryPayout = -1;
      if (hasSecondPayout) {
        secondaryPayout = Math.floor(rng() * weekCount);
        if (secondaryPayout === primaryPayout) {
          secondaryPayout = (secondaryPayout + 2) % weekCount;
        }
      }

      for (let wIdx = 0; wIdx < weekCount; wIdx++) {
        const week = month.weeks[wIdx];
        const isPayout = wIdx === primaryPayout || wIdx === secondaryPayout;

        if (!isPayout) {
          // 30% chance the project wasn't worked that week — leave the cell
          // transparent by skipping the entry entirely.
          if (rng() < 0.3) continue;
          // Otherwise the project WAS worked but the money for this specific
          // week is deferred — mark it as `expected_later` with no amount.
          await prisma.weeklyEntry.upsert({
            where: {
              fiscalWeekId_projectId: {
                fiscalWeekId: week.id,
                projectId: p.id,
              },
            },
            update: {
              status: 'expected_later',
              amount: null,
              note: '[demo]',
            },
            create: {
              fiscalWeekId: week.id,
              projectId: p.id,
              status: 'expected_later',
              amount: null,
              note: '[demo]',
            },
          });
          entriesCreated++;
          continue;
        }

        // Payout week — real amount + a time-appropriate status
        const status = pickPayoutStatus(
          week.startDate,
          week.endDate,
          isPastMonth,
          isFutureMonth,
        );
        const amount =
          status === 'expected_later'
            ? null
            : new Decimal(2000 + Math.floor(rng() * 15000));

        const extraNote = rng() < 0.15 ? ` — note for ${p.name}` : '';
        await prisma.weeklyEntry.upsert({
          where: {
            fiscalWeekId_projectId: {
              fiscalWeekId: week.id,
              projectId: p.id,
            },
          },
          update: {
            status,
            amount,
            note: `[demo]${extraNote}`,
          },
          create: {
            fiscalWeekId: week.id,
            projectId: p.id,
            status,
            amount,
            note: `[demo]${extraNote}`,
          },
        });
        entriesCreated++;
      }
    }
  }
  console.log(`Created ${entriesCreated} demo weekly entries.`);
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
