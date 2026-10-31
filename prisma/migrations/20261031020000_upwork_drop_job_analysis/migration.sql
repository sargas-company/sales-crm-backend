-- Drop the `job_analysis` section. Research notes live in a
-- markdown file outside the CRM; there is no such profile section.
-- Postgres does not support dropping enum values in place, so we do
-- the standard swap: new enum → recast → drop old → rename.

-- Nuke any existing rows for this section (owner's call, data lost).
DELETE FROM "UpworkChangeLog" WHERE section = 'job_analysis';

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
