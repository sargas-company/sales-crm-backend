-- Mirror of Lead.location — free-text string holding either a
-- country name or "City, Country". Nullable, no backfill.
ALTER TABLE "Client" ADD COLUMN "location" TEXT;
