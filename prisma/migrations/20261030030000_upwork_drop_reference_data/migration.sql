-- Collapse reference-data: positions now carry the phrase inline;
-- change-log loses its references join; the standalone ref-data
-- entity and its enum are dropped. Owner-level research notes move
-- out of the CRM into a flat markdown file.

-- 1. Add phrase column, backfill from UpworkReferenceData.value
--    (normalized: trimmed, collapsed whitespace, lower-cased).
ALTER TABLE "UpworkMetricsSnapshotPosition"
  ADD COLUMN "phrase" TEXT;

UPDATE "UpworkMetricsSnapshotPosition" p
SET "phrase" = lower(trim(regexp_replace(rd."value", '\s+', ' ', 'g')))
FROM "UpworkReferenceData" rd
WHERE rd."id" = p."referenceDataId";

-- 2. Dedup (same snapshot + same normalized phrase).
--    Keep the row with the lowest position (best rank captured);
--    on ties, keep the one with the smallest id.
DELETE FROM "UpworkMetricsSnapshotPosition" a
USING "UpworkMetricsSnapshotPosition" b
WHERE a."snapshotId" = b."snapshotId"
  AND a."phrase"     = b."phrase"
  AND a."position"   > b."position";

DELETE FROM "UpworkMetricsSnapshotPosition" a
USING "UpworkMetricsSnapshotPosition" b
WHERE a."snapshotId" = b."snapshotId"
  AND a."phrase"     = b."phrase"
  AND a."position"   = b."position"
  AND a."id"         > b."id";

ALTER TABLE "UpworkMetricsSnapshotPosition"
  ALTER COLUMN "phrase" SET NOT NULL;

CREATE UNIQUE INDEX "UpworkMetricsSnapshotPosition_snapshotId_phrase_key"
  ON "UpworkMetricsSnapshotPosition"("snapshotId", "phrase");
CREATE INDEX "UpworkMetricsSnapshotPosition_phrase_idx"
  ON "UpworkMetricsSnapshotPosition"("phrase");

-- 3. Drop the FK + referenceDataId column + its old unique index.
--    FK was originally named `..._ref_fkey` in the initial Upwork
--    migration — keep the real DB name here.
ALTER TABLE "UpworkMetricsSnapshotPosition"
  DROP CONSTRAINT "UpworkMetricsSnapshotPosition_ref_fkey";

DROP INDEX IF EXISTS "UpworkMetricsSnapshotPosition_snapshotId_referenceDataId_key";
DROP INDEX IF EXISTS "UpworkMetricsSnapshotPosition_referenceDataId_idx";

ALTER TABLE "UpworkMetricsSnapshotPosition"
  DROP COLUMN "referenceDataId";

-- 4. Drop change-log → ref-data join table.
DROP TABLE "UpworkChangeLogReference";

-- 5. Drop ref-data entity + enum.
DROP TABLE "UpworkReferenceData";
DROP TYPE "UpworkReferenceCategory";
