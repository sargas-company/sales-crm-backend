-- AlterTable
ALTER TABLE "WeeklyEntry"
  ADD COLUMN "invoiceSentAt" DATE,
  ADD COLUMN "receivedAt"    DATE;
