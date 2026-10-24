/* eslint-disable no-console */
/**
 * Incremental top-up seeder for Finance block testing.
 *
 * Base demo data (PaymentSource, compensation rates, past payroll,
 * invoices, salary reviews) already lands via
 *   • prisma db seed
 *   • seed-employees-projects-demo.ts
 *   • seed-finance-weekly-demo.ts
 *
 * What this script covers that is still missing after the base run:
 *   • Payroll entries for the CURRENT fiscal month (DRAFT) for every
 *     active employee — so Monthly-run surfaces have "live" rows.
 *   • A few SalaryReview rows with result = NO_CHANGE (base seed only
 *     covers INCREASED, POSTPONED and pending).
 *
 * LOCAL ONLY. Guard replicates assert-local-db.ts (APP_ENV, host,
 * port, db name).
 *
 * Usage:  APP_ENV=local npx ts-node scripts/seed-finance-top-up-demo.ts
 *
 * Idempotent: every row is tagged with the marker '[seed:finance-top-up]'
 * in `note`; the script deletes those rows before re-inserting, so
 * repeat runs produce the same final state and never clobber real
 * data or earlier seeds.
 */
import 'dotenv/config';
import { PrismaClient, Prisma, PayrollStatus, SalaryReviewResult, RateType } from '@prisma/client';

const { Decimal } = Prisma;

const MARKER = '[seed:finance-top-up]';

// ─── Local-DB guard ────────────────────────────────────────────────

const HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];
const EXPECTED_PORT = '5433';
const DB_NAME_ALLOWLIST = ['ai_dashboard'];

function assertLocal(): void {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== 'local') {
    console.error(`seed-finance-top-up-demo: APP_ENV="${appEnv ?? ''}" — refusing (expected "local")`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('seed-finance-top-up-demo: DATABASE_URL not set — refusing');
    process.exit(1);
  }
  try {
    const parsed = new URL(url);
    if (!HOST_ALLOWLIST.includes(parsed.hostname)) {
      console.error(`seed-finance-top-up-demo: host ${parsed.hostname} not allowed`);
      process.exit(1);
    }
    if (parsed.port !== EXPECTED_PORT) {
      console.error(`seed-finance-top-up-demo: port ${parsed.port} not allowed (expected ${EXPECTED_PORT})`);
      process.exit(1);
    }
    const dbName = parsed.pathname.replace(/^\//, '');
    if (!DB_NAME_ALLOWLIST.includes(dbName)) {
      console.error(`seed-finance-top-up-demo: db ${dbName} not allowed`);
      process.exit(1);
    }
  } catch (e) {
    console.error('seed-finance-top-up-demo: DATABASE_URL unparseable — refusing', e);
    process.exit(1);
  }
}

assertLocal();
const prisma = new PrismaClient();

/* Payroll computation — mirrors payroll.service.computeAll():
 *   tax           = base > 0 ? 42.5 + base * 6% : 0
 *   salaryWithTax = base + tax
 *   bonusAmount   = base * bonusPercent/100 + fixedBonus
 *   totalAccrued  = salaryWithTax + bonusAmount
 *   owed          = max(0, totalAccrued - advance)
 *   payoneerFee   = owed === 0 ? 0 : owed * r / (1 - r)   // gross-up
 *   remainingToPay= owed + payoneerFee
 *   companyCost   = totalAccrued + payoneerFee
 * Keeping this in step with the service means seeded rows are
 * indistinguishable from rows saved through the UI. */
function computePayroll(args: {
  rateType: RateType;
  rate: number;
  hours: number | null;
  bonusPct: number;
  fixedBonus: number;
  advance: number;
}) {
  const base =
    args.rateType === 'HOURLY'
      ? args.rate * (args.hours ?? 0)
      : args.rate;
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
  console.log(`seed-finance-top-up-demo: starting (marker=${MARKER})`);

  // Wipe previous rows under this marker.
  const wipedPayrolls = await prisma.payrollEntry.deleteMany({ where: { note: { startsWith: MARKER } } });
  const wipedReviews = await prisma.salaryReview.deleteMany({ where: { note: { startsWith: MARKER } } });
  console.log(`Cleared previous top-up rows: payroll=${wipedPayrolls.count} reviews=${wipedReviews.count}`);

  // ─── Current-month payroll (DRAFT) for every active employee ────

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-based

  const activeEmps = await prisma.employee.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, firstName: true, lastName: true },
  });
  console.log(`Active employees: ${activeEmps.length}`);

  // For each, read current compensation (effectiveDate <= today).
  let payrollInserted = 0;
  for (const emp of activeEmps) {
    const rate = await prisma.employeeCompensationRate.findFirst({
      where: { employeeId: emp.id, effectiveDate: { lte: now } },
      orderBy: { effectiveDate: 'desc' },
    });
    if (!rate) {
      console.warn(`  skip (no current rate): ${emp.firstName} ${emp.lastName}`);
      continue;
    }

    // Skip if a row for this (employee, year, month) already exists —
    // another seed covered it, don't collide.
    const dup = await prisma.payrollEntry.findUnique({
      where: { employeeId_year_month: { employeeId: emp.id, year, month } },
      select: { id: true },
    });
    if (dup) continue;

    const hours = rate.rateType === 'HOURLY' ? 160 + Math.floor(Math.random() * 20) : null;
    const bonusPct = Math.random() < 0.3 ? 10 : 0;
    const fixedBonus = Math.random() < 0.2 ? 200 : 0;
    const advance = Math.random() < 0.25 ? 500 : 0;

    const calc = computePayroll({
      rateType: rate.rateType,
      rate: Number(rate.rate),
      hours,
      bonusPct,
      fixedBonus,
      advance,
    });

    await prisma.payrollEntry.create({
      data: {
        employeeId: emp.id,
        year,
        month,
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
        note: `${MARKER} current-month DRAFT`,
        status: PayrollStatus.DRAFT,
      },
    });
    payrollInserted++;
  }
  console.log(`Inserted ${payrollInserted} DRAFT payroll entries for ${year}-${String(month).padStart(2, '0')}.`);

  // ─── NO_CHANGE SalaryReviews (3 of them) ───────────────────────

  const pickThree = activeEmps.slice(0, 3);
  const yearAgo = new Date();
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setUTCMonth(threeMonthsAgo.getUTCMonth() - 3);

  const nocBuckets = [yearAgo, sixMonthsAgo, threeMonthsAgo];
  let reviewsInserted = 0;
  for (let i = 0; i < pickThree.length; i++) {
    const emp = pickThree[i];
    const rate = await prisma.employeeCompensationRate.findFirst({
      where: { employeeId: emp.id, effectiveDate: { lte: nocBuckets[i] } },
      orderBy: { effectiveDate: 'desc' },
    });
    if (!rate) continue;
    await prisma.salaryReview.create({
      data: {
        employeeId: emp.id,
        scheduledDate: nocBuckets[i],
        previousRateType: rate.rateType,
        previousRate: rate.rate,
        newRateType: rate.rateType,
        newRate: rate.rate,
        effectiveDate: nocBuckets[i],
        result: SalaryReviewResult.NO_CHANGE,
        note: `${MARKER} no-change review`,
        completedAt: nocBuckets[i],
      },
    });
    reviewsInserted++;
  }
  console.log(`Inserted ${reviewsInserted} NO_CHANGE salary reviews.`);

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
