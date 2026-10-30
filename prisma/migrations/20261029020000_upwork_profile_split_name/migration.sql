-- Split UpworkProfile.name into firstName / lastName / title.
-- The old `name` column was a single display label; the new shape
-- mirrors the Lead / Client contact-name structure. Done in-place
-- because the module has not been deployed to prod yet.

ALTER TABLE "UpworkProfile" ADD COLUMN "firstName" TEXT;
ALTER TABLE "UpworkProfile" ADD COLUMN "lastName"  TEXT;
ALTER TABLE "UpworkProfile" ADD COLUMN "title"     TEXT;

-- Backfill: split `name` on first space; everything before = firstName,
-- rest = lastName. Pure-text rows become firstName only.
UPDATE "UpworkProfile"
SET
  "firstName" = COALESCE(NULLIF(split_part("name", ' ', 1), ''), "name"),
  "lastName"  = NULLIF(
    TRIM(SUBSTRING("name" FROM POSITION(' ' IN "name") + 1)),
    "name"
  )
WHERE "firstName" IS NULL;

ALTER TABLE "UpworkProfile" ALTER COLUMN "firstName" SET NOT NULL;
ALTER TABLE "UpworkProfile" DROP COLUMN "name";
