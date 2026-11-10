-- UpworkKeyword: per-profile tracked phrase. Replaces the free-text
-- `phrase` on UpworkMetricsSnapshotPosition. Backfill is inline: for
-- every existing position row we derive-or-reuse a keyword row with
-- the same normalized text, then wire the FK up. The old `phrase`
-- column stays in place through this migration — the cutover
-- migration that follows flips `keywordId` to NOT NULL and drops it.

CREATE TABLE "UpworkKeyword" (
  "id"         TEXT NOT NULL,
  "profileId"  TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "isPrimary"  BOOLEAN NOT NULL DEFAULT false,
  "isActive"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UpworkKeyword_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UpworkKeyword_profileId_text_key"
  ON "UpworkKeyword"("profileId", "text");

CREATE INDEX "UpworkKeyword_profileId_isActive_idx"
  ON "UpworkKeyword"("profileId", "isActive");

-- At most one primary keyword per profile.
CREATE UNIQUE INDEX "UpworkKeyword_profileId_primary_key"
  ON "UpworkKeyword"("profileId")
  WHERE "isPrimary" = true;

ALTER TABLE "UpworkKeyword"
  ADD CONSTRAINT "UpworkKeyword_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "UpworkProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable FK on existing positions. Flipped to NOT NULL in the next
-- migration once backfill has populated every row.
ALTER TABLE "UpworkMetricsSnapshotPosition"
  ADD COLUMN "keywordId" TEXT;

-- Backfill: create a keyword row per (profileId, normalized phrase)
-- that occurs in existing positions. `phrase` is already stored
-- normalized by the current service, so we reuse it as-is.
INSERT INTO "UpworkKeyword" ("id", "profileId", "text", "updatedAt")
SELECT
  gen_random_uuid()::text,
  s."profileId",
  p."phrase",
  NOW()
FROM "UpworkMetricsSnapshotPosition" p
JOIN "UpworkMetricsSnapshot" s ON s."id" = p."snapshotId"
GROUP BY s."profileId", p."phrase"
ON CONFLICT ("profileId", "text") DO NOTHING;

-- Wire up every position row to its freshly-created (or pre-existing)
-- keyword row.
UPDATE "UpworkMetricsSnapshotPosition" p
SET "keywordId" = k."id"
FROM "UpworkMetricsSnapshot" s, "UpworkKeyword" k
WHERE p."snapshotId" = s."id"
  AND k."profileId"  = s."profileId"
  AND k."text"       = p."phrase"
  AND p."keywordId" IS NULL;

ALTER TABLE "UpworkMetricsSnapshotPosition"
  ADD CONSTRAINT "UpworkMetricsSnapshotPosition_keywordId_fkey"
  FOREIGN KEY ("keywordId") REFERENCES "UpworkKeyword"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "UpworkMetricsSnapshotPosition_keywordId_idx"
  ON "UpworkMetricsSnapshotPosition"("keywordId");
