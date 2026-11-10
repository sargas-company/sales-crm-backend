-- UpworkMetricsSnapshotPosition cutover: `keywordId` is now the
-- canonical phrase reference. The free-text `phrase` column and the
-- (snapshotId, phrase) unique index are dropped. Runs directly after
-- the additive migration, which created the keyword rows and wired
-- `keywordId` for every existing position row.

ALTER TABLE "UpworkMetricsSnapshotPosition"
  ALTER COLUMN "keywordId" SET NOT NULL;

ALTER TABLE "UpworkMetricsSnapshotPosition"
  ADD CONSTRAINT "UpworkMetricsSnapshotPosition_snapshotId_keywordId_key"
  UNIQUE ("snapshotId", "keywordId");

DROP INDEX IF EXISTS "UpworkMetricsSnapshotPosition_phrase_idx";

ALTER TABLE "UpworkMetricsSnapshotPosition"
  DROP CONSTRAINT IF EXISTS "UpworkMetricsSnapshotPosition_snapshotId_phrase_key";

ALTER TABLE "UpworkMetricsSnapshotPosition"
  DROP COLUMN "phrase";
