-- Drop unused DiscordJobType.UPWORK_REMINDERS. The Discord upwork
-- reminders card was removed in favour of the attention-panel
-- aggregation; the enum value became orphaned.
--
-- Postgres has no DROP VALUE for enums, so we swap the type: create
-- a new enum without the value, migrate the column, drop the old,
-- rename the new. Safe because no DiscordDelivery row references
-- UPWORK_REMINDERS (never wired up end-to-end).

DELETE FROM "DiscordDelivery" WHERE "jobType" = 'UPWORK_REMINDERS';

CREATE TYPE "DiscordJobType_new" AS ENUM (
  'REMINDER_18',
  'DAILY_DIGEST_19',
  'WEEKLY_DIGEST',
  'BIRTHDAY',
  'ABSENCES',
  'LATE_REPORT',
  'TEST'
);

ALTER TABLE "DiscordDelivery"
  ALTER COLUMN "jobType" TYPE "DiscordJobType_new"
  USING "jobType"::text::"DiscordJobType_new";

DROP TYPE "DiscordJobType";
ALTER TYPE "DiscordJobType_new" RENAME TO "DiscordJobType";
