-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM (
  'received',
  'in_transit',
  'expected_this_month',
  'expected_later',
  'planned_invoice',
  'no_work'
);

-- CreateEnum
CREATE TYPE "PaymentRuleType" AS ENUM (
  'FIXED_DELAY',
  'WEEKLY_ON_DOW',
  'EVERY_N_WEEKS',
  'CUSTOM'
);

-- CreateTable
CREATE TABLE "FiscalMonth" (
  "id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "sequenceInYear" INTEGER NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "weeksCount" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FiscalMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalWeek" (
  "id" TEXT NOT NULL,
  "fiscalMonthId" TEXT NOT NULL,
  "indexInMonth" INTEGER NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "label" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FiscalWeek_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyEntry" (
  "id" TEXT NOT NULL,
  "fiscalWeekId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "amount" DECIMAL(12,2),
  "status" "PaymentStatus" NOT NULL,
  "note" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WeeklyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectPaymentRule" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "type" "PaymentRuleType" NOT NULL,
  "delayDays" INTEGER,
  "dayOfWeek" INTEGER,
  "intervalWeeks" INTEGER,
  "note" TEXT,
  "effectiveFrom" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectPaymentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalMonth_year_sequenceInYear_key" ON "FiscalMonth"("year", "sequenceInYear");

-- CreateIndex
CREATE INDEX "FiscalMonth_startDate_idx" ON "FiscalMonth"("startDate");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalWeek_fiscalMonthId_indexInMonth_key" ON "FiscalWeek"("fiscalMonthId", "indexInMonth");

-- CreateIndex
CREATE INDEX "FiscalWeek_startDate_idx" ON "FiscalWeek"("startDate");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyEntry_fiscalWeekId_projectId_key" ON "WeeklyEntry"("fiscalWeekId", "projectId");

-- CreateIndex
CREATE INDEX "WeeklyEntry_projectId_idx" ON "WeeklyEntry"("projectId");

-- CreateIndex
CREATE INDEX "WeeklyEntry_status_idx" ON "WeeklyEntry"("status");

-- CreateIndex
CREATE INDEX "ProjectPaymentRule_projectId_effectiveFrom_idx" ON "ProjectPaymentRule"("projectId", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "FiscalWeek" ADD CONSTRAINT "FiscalWeek_fiscalMonthId_fkey" FOREIGN KEY ("fiscalMonthId") REFERENCES "FiscalMonth"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyEntry" ADD CONSTRAINT "WeeklyEntry_fiscalWeekId_fkey" FOREIGN KEY ("fiscalWeekId") REFERENCES "FiscalWeek"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyEntry" ADD CONSTRAINT "WeeklyEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPaymentRule" ADD CONSTRAINT "ProjectPaymentRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
