-- Store the per-run Payoneer fee % directly instead of inferring it
-- from the dollar amount on read. Default 3 matches the Monthly Run
-- toggle default + the global settings default.
--
-- Backfill: existing rows get `payoneerFee / totalAccrued × 100`
-- rounded to the nearest half-percent — avoids losing the historical
-- choice for rows already saved before this column existed.

ALTER TABLE "PayrollEntry"
  ADD COLUMN "payoneerFeePct" DECIMAL(5, 2) NOT NULL DEFAULT 3;

UPDATE "PayrollEntry"
   SET "payoneerFeePct" = ROUND(
         ("payoneerFee" / NULLIF("totalAccrued", 0)) * 100,
         2
       )
 WHERE "totalAccrued" > 0
   AND "payoneerFee" IS NOT NULL;
