-- Drop old slug unique constraint
ALTER TABLE "Account" DROP CONSTRAINT IF EXISTS "Account_userId_slug_key";

-- Drop slug column
ALTER TABLE "Account" DROP COLUMN IF EXISTS "slug";

-- Remove duplicate accounts, keeping the most recent one per userId+platformId
DELETE FROM "Account" a
USING "Account" b
WHERE a."userId" = b."userId"
  AND a."platformId" = b."platformId"
  AND a."createdAt" < b."createdAt";

-- Add unique constraint: one account per user per platform
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_platformId_key" UNIQUE ("userId", "platformId");
