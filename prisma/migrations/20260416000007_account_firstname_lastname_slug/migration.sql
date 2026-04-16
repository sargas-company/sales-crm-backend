-- Drop constraint from previous migration
ALTER TABLE "Account" DROP CONSTRAINT IF EXISTS "Account_userId_platformId_key";

-- Add firstName, lastName, slug columns
ALTER TABLE "Account"
  ADD COLUMN "firstName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastName"  TEXT NOT NULL DEFAULT '',
  ADD COLUMN "slug"      TEXT NOT NULL DEFAULT '';

-- Remove defaults (they were only needed for existing rows)
ALTER TABLE "Account"
  ALTER COLUMN "firstName" DROP DEFAULT,
  ALTER COLUMN "lastName"  DROP DEFAULT,
  ALTER COLUMN "slug"      DROP DEFAULT;

-- Add unique constraint on userId + slug
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_slug_key" UNIQUE ("userId", "slug");
