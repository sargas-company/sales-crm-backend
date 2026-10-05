-- Compensation + Payroll + Salary Reviews + Payment Sources.
--
-- Compensation model:
--   * EmployeeCompensationRate holds effective-dated rates (HOURLY/MONTHLY).
--     Payroll for a given month looks up the rate active on that period.
--   * PayrollEntry snapshots rateType/rate/tax/bonus at write time so a
--     future rate change never rewrites historical months.
--   * SalaryReview records a scheduled or completed review; when result is
--     INCREASED the service layer creates a new EmployeeCompensationRate.
--   * PaymentSource is a lightweight directory (no ledger/balance yet).

CREATE TYPE "RateType" AS ENUM ('HOURLY', 'MONTHLY');
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'PAID');
CREATE TYPE "SalaryReviewResult" AS ENUM ('INCREASED', 'NO_CHANGE', 'POSTPONED');

-- ── EmployeeCompensationRate ────────────────────────────────────────────
CREATE TABLE "EmployeeCompensationRate" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "rateType" "RateType" NOT NULL,
    "rate" DECIMAL(12, 2) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeCompensationRate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeCompensationRate_employeeId_effectiveDate_idx"
    ON "EmployeeCompensationRate"("employeeId", "effectiveDate");

ALTER TABLE "EmployeeCompensationRate"
    ADD CONSTRAINT "EmployeeCompensationRate_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PayrollEntry ────────────────────────────────────────────────────────
CREATE TABLE "PayrollEntry" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "rateType" "RateType" NOT NULL,
    "rate" DECIMAL(12, 2) NOT NULL,
    "hours" DECIMAL(10, 2),
    "baseSalary" DECIMAL(12, 2) NOT NULL,
    "tax" DECIMAL(12, 2) NOT NULL,
    "salaryWithTax" DECIMAL(12, 2) NOT NULL,
    "bonusPercent" DECIMAL(6, 2) NOT NULL DEFAULT 0,
    "fixedBonus" DECIMAL(12, 2) NOT NULL DEFAULT 0,
    "bonusAmount" DECIMAL(12, 2) NOT NULL,
    "advance" DECIMAL(12, 2) NOT NULL DEFAULT 0,
    "totalAccrued" DECIMAL(12, 2) NOT NULL,
    "remainingToPay" DECIMAL(12, 2) NOT NULL,
    "payoneerFee" DECIMAL(12, 2) NOT NULL,
    "companyCost" DECIMAL(12, 2) NOT NULL,
    "note" TEXT,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollEntry_employeeId_year_month_key"
    ON "PayrollEntry"("employeeId", "year", "month");
CREATE INDEX "PayrollEntry_year_month_idx" ON "PayrollEntry"("year", "month");
CREATE INDEX "PayrollEntry_status_idx" ON "PayrollEntry"("status");

ALTER TABLE "PayrollEntry"
    ADD CONSTRAINT "PayrollEntry_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── SalaryReview ────────────────────────────────────────────────────────
CREATE TABLE "SalaryReview" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "previousRateType" "RateType",
    "previousRate" DECIMAL(12, 2),
    "newRateType" "RateType",
    "newRate" DECIMAL(12, 2),
    "effectiveDate" DATE,
    "result" "SalaryReviewResult",
    "note" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SalaryReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalaryReview_employeeId_scheduledDate_idx"
    ON "SalaryReview"("employeeId", "scheduledDate");
CREATE INDEX "SalaryReview_scheduledDate_idx" ON "SalaryReview"("scheduledDate");
CREATE INDEX "SalaryReview_result_idx" ON "SalaryReview"("result");

ALTER TABLE "SalaryReview"
    ADD CONSTRAINT "SalaryReview_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PaymentSource ───────────────────────────────────────────────────────
CREATE TABLE "PaymentSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentSource_isActive_idx" ON "PaymentSource"("isActive");

-- ── Permission catalogue ────────────────────────────────────────────────
-- New: compensation_analytics:view. The other keys used by these modules
-- (salaries:*, compensation_reviews:*, payment_sources:*) already live in
-- the catalogue from the earlier roles migration and are seeded by seed.ts.
INSERT INTO "Permission" ("id", "key", "module", "action", "label", "description", "createdAt")
VALUES (gen_random_uuid(), 'compensation_analytics:view', 'compensation_analytics', 'view',
        'View Compensation Analytics dashboard', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Owner has every permission. Wire the new key to the Owner role.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT '00000000-0000-0000-0000-000000000101', p.id
FROM "Permission" p
WHERE p.key = 'compensation_analytics:view'
ON CONFLICT DO NOTHING;
