-- Project billing shape: a type enum plus three optional columns
-- (rate / currency / hours budget). All additive and nullable so
-- existing rows are untouched; owner tags each engagement from the
-- UI as needed.
--
-- Cadence of `rate` is implied by `type`:
--   HOURLY   → $/hour, `hoursBudget` is the optional cap in hours.
--   RETAINER → $/month, `hoursBudget` ignored.
--   FIXED    → flat contract value, `hoursBudget` ignored.

CREATE TYPE "ProjectType" AS ENUM ('HOURLY', 'FIXED', 'RETAINER');

ALTER TABLE "Project"
  ADD COLUMN "type"         "ProjectType",
  ADD COLUMN "rate"         DECIMAL(14, 2),
  ADD COLUMN "rateCurrency" CHAR(3),
  ADD COLUMN "hoursBudget"  INTEGER;
