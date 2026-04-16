-- Drop old unique constraint and columns
DROP INDEX IF EXISTS "Account_userId_slug_key";

ALTER TABLE "Account" DROP COLUMN IF EXISTS "name",
                      DROP COLUMN IF EXISTS "slug";

-- Add new unique constraint: one account per user per platform
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_platformId_key" UNIQUE ("userId", "platformId");
