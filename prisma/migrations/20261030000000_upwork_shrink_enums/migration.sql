-- Narrow UpworkChangeLogSection (drop contract, video, other) and
-- UpworkReferenceCategory (drop hire_list_skill). Rows that used
-- the removed values are demo-seed only — delete them.

-- 1. Delete rows that reference values about to disappear.
--    UpworkChangeLogReference → UpworkReferenceData is ON DELETE
--    RESTRICT, so link rows must go first before deleting the
--    hire_list_skill reference entries themselves.
DELETE FROM "UpworkChangeLog"
WHERE "section" IN ('contract', 'video', 'other');

DELETE FROM "UpworkChangeLogReference"
WHERE "referenceDataId" IN (
  SELECT "id" FROM "UpworkReferenceData" WHERE "category" = 'hire_list_skill'
);

DELETE FROM "UpworkReferenceData"
WHERE "category" = 'hire_list_skill';

-- 2. Recreate the two enums without the removed values.
--    PostgreSQL has no direct DROP VALUE — standard swap pattern.
CREATE TYPE "UpworkChangeLogSection_new" AS ENUM (
  'title',
  'overview',
  'skills',
  'portfolio',
  'project_catalog',
  'consultation',
  'certificate',
  'employment_history',
  'other_experience'
);
ALTER TABLE "UpworkChangeLog"
  ALTER COLUMN "section" TYPE "UpworkChangeLogSection_new"
  USING "section"::text::"UpworkChangeLogSection_new";
DROP TYPE "UpworkChangeLogSection";
ALTER TYPE "UpworkChangeLogSection_new" RENAME TO "UpworkChangeLogSection";

CREATE TYPE "UpworkReferenceCategory_new" AS ENUM (
  'title_phrase',
  'suggestion',
  'related_query',
  'green_skill',
  'job_skill',
  'client_phrase',
  'requirement',
  'product_type',
  'fact'
);
ALTER TABLE "UpworkReferenceData"
  ALTER COLUMN "category" TYPE "UpworkReferenceCategory_new"
  USING "category"::text::"UpworkReferenceCategory_new";
DROP TYPE "UpworkReferenceCategory";
ALTER TYPE "UpworkReferenceCategory_new" RENAME TO "UpworkReferenceCategory";
