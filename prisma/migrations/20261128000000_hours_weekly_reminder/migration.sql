-- Weekly Upwork-hours Discord reminder.
-- Additive-only: new fields on DiscordProfile + new job-type enum value.

ALTER TABLE "DiscordProfile"
  ADD COLUMN IF NOT EXISTS "hoursReminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hoursReminderDow" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS "hoursReminderAt" TEXT NOT NULL DEFAULT '18:00';

ALTER TYPE "DiscordJobType" ADD VALUE IF NOT EXISTS 'HOURS_WEEKLY_REMINDER';
