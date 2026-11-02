#!/usr/bin/env ts-node
/**
 * One-shot backfill for `PayrollEntry.{payoneerFee, remainingToPay,
 * companyCost}`. Rows persisted before the Payoneer gross-up fix
 * (`723730d`, 2026-10-24) stored `fee = owed * r` instead of the
 * actual `fee = owed * r / (1 - r)` Payoneer charges on the gross.
 * This recomputes the three affected fields from already-stored
 * `totalAccrued`, `advance` and `payoneerFeePct`. All other money
 * fields (baseSalary / tax / salaryWithTax / bonusAmount /
 * totalAccrued) were correct and are NOT touched.
 *
 * Defaults to DRY-RUN. Pass `--apply` to write.
 *
 *   npx ts-node scripts/backfill-payroll-company-cost.ts
 *   npx ts-node scripts/backfill-payroll-company-cost.ts --apply
 *
 * Idempotent: a second run with correct values reports 0 changes.
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';

const { Decimal } = Prisma;
type D = Prisma.Decimal;

const round2 = (d: D): D => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

function recompute(row: {
  totalAccrued: D;
  advance: D;
  payoneerFeePct: D;
}): { payoneerFee: D; remainingToPay: D; companyCost: D } {
  const r = row.payoneerFeePct.div(100);
  const owedRaw = row.totalAccrued.minus(row.advance);
  const owed = owedRaw.isNegative() ? new Decimal(0) : owedRaw;
  const payoneerFee = owed.isZero()
    ? new Decimal(0)
    : round2(owed.times(r).div(new Decimal(1).minus(r)));
  const remainingToPay = round2(owed.plus(payoneerFee));
  const companyCost = round2(row.totalAccrued.plus(payoneerFee));
  return { payoneerFee, remainingToPay, companyCost };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  const rows = await prisma.payrollEntry.findMany({
    select: {
      id: true,
      employeeId: true,
      year: true,
      month: true,
      totalAccrued: true,
      advance: true,
      payoneerFeePct: true,
      payoneerFee: true,
      remainingToPay: true,
      companyCost: true,
    },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });

  let changed = 0;
  const perMonth = new Map<string, { oldSum: D; newSum: D; delta: D; n: number }>();

  for (const r of rows) {
    const next = recompute(r);
    const feeDiff = !next.payoneerFee.equals(r.payoneerFee);
    const remDiff = !next.remainingToPay.equals(r.remainingToPay);
    const costDiff = !next.companyCost.equals(r.companyCost);
    if (!feeDiff && !remDiff && !costDiff) continue;
    changed += 1;
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    const bucket = perMonth.get(key) ?? {
      oldSum: new Decimal(0),
      newSum: new Decimal(0),
      delta: new Decimal(0),
      n: 0,
    };
    bucket.oldSum = bucket.oldSum.plus(r.companyCost);
    bucket.newSum = bucket.newSum.plus(next.companyCost);
    bucket.delta = bucket.delta.plus(next.companyCost.minus(r.companyCost));
    bucket.n += 1;
    perMonth.set(key, bucket);

    if (apply) {
      await prisma.payrollEntry.update({
        where: { id: r.id },
        data: {
          payoneerFee: next.payoneerFee,
          remainingToPay: next.remainingToPay,
          companyCost: next.companyCost,
        },
      });
    }
  }

  console.log(`\nScanned ${rows.length} rows, ${changed} differ.\n`);
  if (perMonth.size > 0) {
    console.log('Per-month companyCost delta:');
    console.log('month      rows        old           new         Δ');
    const sortedKeys = Array.from(perMonth.keys()).sort();
    for (const key of sortedKeys) {
      const b = perMonth.get(key)!;
      console.log(
        `${key}   ${String(b.n).padStart(3)}  ${b.oldSum.toFixed(2).padStart(12)}  ${b.newSum.toFixed(2).padStart(12)}  ${b.delta.toFixed(2).padStart(8)}`,
      );
    }
  }
  console.log(apply ? '\nWrote changes.' : '\nDRY-RUN — no writes. Pass --apply to persist.');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
