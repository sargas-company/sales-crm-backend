-- Drop stale array-column DEFAULTs that were introduced by earlier ad-hoc
-- DDL on the local database but never declared in schema.prisma. Removing
-- them aligns the DB with the Prisma model. No data change — DEFAULT only.
-- On environments where the defaults never existed (fresh deploys), these
-- statements are a no-op.
ALTER TABLE "LinkedInIdea" ALTER COLUMN "tags" DROP DEFAULT;
ALTER TABLE "LinkedInIdea" ALTER COLUMN "referenceLinks" DROP DEFAULT;
ALTER TABLE "LinkedInPost" ALTER COLUMN "hashtags" DROP DEFAULT;
