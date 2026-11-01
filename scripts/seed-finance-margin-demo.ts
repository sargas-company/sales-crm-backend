/* eslint-disable no-console */
/**
 * Local-only margin seeder.
 *
 * Fills PAID PayrollEntry rows for every active employee for the
 * past N fiscal months in the current year (default: 11, i.e. all
 * months before the current one). Each row's paidAt lands inside
 * the fiscal month it belongs to, which is what the Monthly margin
 * panel on Finance Analytics buckets by.
 *
 * Pairs with seed-finance-weekly-demo.ts (revenue side) and
 * seed-finance-top-up-demo.ts (current-month DRAFT). After running
 * all three, the Monthly margin table shows filled rows for the
 * finished months of the current year.
 *
 * LOCAL ONLY. Guard replicates assert-local-db.ts.
 *
 * Usage:  APP_ENV=local npx ts-node scripts/seed-finance-margin-demo.ts
 *
 * Idempotent: every row tagged with the marker '[seed:finance-margin]'
 * in `note`; the script deletes those rows before re-inserting.
 */
import 'dotenv/config';
import { PrismaClient, Prisma, PayrollStatus, RateType } from '@prisma/client';

const { Decimal } = Prisma;

const MARKER = '[seed:finance-margin]';

const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function assertLocal(): void {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== 'local') {
    console.error(`seed-finance-margin-demo: APP_ENV="${appEnv ?? ''}" — refusing`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed-finance-margin-demo: DATABASE_URL not set — refusing');
    process.exit(1);
  }
  try {
    const parsed = new URL(url);
    if (!HOST_ALLOWLIST.includes(parsed.hostname)) {
      console.error(`seed-finance-margin-demo: host ${parsed.hostname} not allowed`);
      process.exit(1);
    }
    if (parsed.port !== EXPECTED_PORT) {
      console.error(`seed-finance-margin-demo: port ${parsed.port} not allowed`);
      process.exit(1);
    }
    const dbName = parsed.pathname.replace(/^\//, '');
    if (!DB_NAME_ALLOWLIST.includes(dbName)) {
      console.error(`seed-finance-margin-demo: db ${dbName} not allowed`);
      process.exit(1);
    }
  } catch (e) {
    console.error('seed-finance-margin-demo: DATABASE_URL unparseable — refusing', e);
    process.exit(1);
  }
}

assertLocal();
const prisma = new PrismaClient();

function computePayroll(args: {
  rateType: RateType;
  rate: number;
  hours: number | null;
  bonusPct: number;
  fixedBonus: number;
  advance: number;
}) {
  const base =
    args.rateType === 'HOURLY' ? args.rate * (args.hours ?? 0) : args.rate;
  const tax = base > 0 ? 42.5 + base * 0.06 : 0;
  const salaryWithTax = base + tax;
  const bonusFromPct = base * (args.bonusPct / 100);
  const bonusAmount = bonusFromPct + args.fixedBonus;
  const totalAccrued = salaryWithTax + bonusAmount;
  const owed = Math.max(0, totalAccrued - args.advance);
  const r = 0.03;
  const payoneerFee = owed === 0 ? 0 : (owed * r) / (1 - r);
  const remainingToPay = owed + payoneerFee;
  const companyCost = totalAccrued + payoneerFee;
  return {
    baseSalary: new Decimal(base.toFixed(2)),
    tax: new Decimal(tax.toFixed(2)),
    salaryWithTax: new Decimal(salaryWithTax.toFixed(2)),
    bonusAmount: new Decimal(bonusAmount.toFixed(2)),
    totalAccrued: new Decimal(totalAccrued.toFixed(2)),
    remainingToPay: new Decimal(remainingToPay.toFixed(2)),
    payoneerFee: new Decimal(payoneerFee.toFixed(2)),
    companyCost: new Decimal(companyCost.toFixed(2)),
  };
}

async function main() {
  console.log(`seed-finance-margin-demo: starting (marker=${MARKER})`);

  const wiped = await prisma.payrollEntry.deleteMany({
    where: { note: { startsWith: MARKER } },
  });
  console.log(`Cleared previous margin rows: payroll=${wiped.count}`);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const fiscalMonths = await prisma.fiscalMonth.findMany({
    where: { year: currentYear },
    orderBy: { sequenceInYear: 'asc' },
  });
  if (fiscalMonths.length === 0) {
    console.error(
      `No fiscal months in ${currentYear}. Regenerate the calendar first.`,
    );
    process.exit(1);
  }

  const pastMonths = fiscalMonths.filter(
    (m) => m.sequenceInYear < currentMonth,
  );
  console.log(
    `Current year ${currentYear}: ${pastMonths.length} past months to backfill (seq 1..${currentMonth - 1}).`,
  );

  const activeEmps = await prisma.employee.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, firstName: true, lastName: true },
  });
  console.log(`Active employees: ${activeEmps.length}`);

  let inserted = 0;
  let skipped = 0;
  for (const emp of activeEmps) {
    const rate = await prisma.employeeCompensationRate.findFirst({
      where: { employeeId: emp.id, effectiveDate: { lte: now } },
      orderBy: { effectiveDate: 'desc' },
    });
    if (!rate) {
      console.warn(`  skip (no rate): ${emp.firstName} ${emp.lastName}`);
      continue;
    }

    for (const fm of pastMonths) {
      const monthNo = fm.sequenceInYear;
      const dup = await prisma.payrollEntry.findUnique({
        where: {
          employeeId_year_month: { employeeId: emp.id, year: currentYear, month: monthNo },
        },
        select: { id: true },
      });
      if (dup) {
        skipped++;
        continue;
      }

      const hours =
        rate.rateType === 'HOURLY' ? 155 + Math.floor(Math.random() * 25) : null;
      const bonusPct = Math.random() < 0.25 ? 10 : 0;
      const fixedBonus = Math.random() < 0.15 ? 200 : 0;
      const advance = Math.random() < 0.2 ? 500 : 0;

      const calc = computePayroll({
        rateType: rate.rateType,
        rate: Number(rate.rate),
        hours,
        bonusPct,
        fixedBonus,
        advance,
      });

      /* paidAt lands roughly in the middle of the fiscal month this
       * payroll row belongs to — any day between startDate and endDate
       * is fine for bucket matching. */
      const span = fm.endDate.getTime() - fm.startDate.getTime();
      const paidAt = new Date(
        fm.startDate.getTime() + Math.floor(span * (0.3 + Math.random() * 0.4)),
      );

      await prisma.payrollEntry.create({
        data: {
          employeeId: emp.id,
          year: currentYear,
          month: monthNo,
          rateType: rate.rateType,
          rate: rate.rate,
          hours: hours === null ? null : new Decimal(hours),
          baseSalary: calc.baseSalary,
          tax: calc.tax,
          salaryWithTax: calc.salaryWithTax,
          bonusPercent: new Decimal(bonusPct),
          fixedBonus: new Decimal(fixedBonus),
          bonusAmount: calc.bonusAmount,
          advance: new Decimal(advance),
          totalAccrued: calc.totalAccrued,
          remainingToPay: calc.remainingToPay,
          payoneerFee: calc.payoneerFee,
          companyCost: calc.companyCost,
          note: `${MARKER} ${currentYear}-${String(monthNo).padStart(2, '0')} PAID`,
          status: PayrollStatus.PAID,
          paidAt,
        },
      });
      inserted++;
    }
  }

  console.log(
    `Done. Inserted ${inserted} PAID payroll rows across ${pastMonths.length} fiscal months (${skipped} skipped — pre-existing).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
