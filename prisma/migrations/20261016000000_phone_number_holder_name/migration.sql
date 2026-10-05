-- Add free-text holder label alongside the existing Employee FK.
ALTER TABLE "PhoneNumber" ADD COLUMN "holderName" TEXT;

-- Backfill from the Employee relation so existing rows keep their
-- current holder label visible.
UPDATE "PhoneNumber" p
SET "holderName" = TRIM(COALESCE(e."firstName", '') || ' ' || COALESCE(e."lastName", ''))
FROM "Employee" e
WHERE p."holderEmployeeId" = e."id"
  AND p."holderName" IS NULL
  AND TRIM(COALESCE(e."firstName", '') || ' ' || COALESCE(e."lastName", '')) <> '';
