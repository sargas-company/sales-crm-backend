-- Adds a nullable anchor used by the reminder cron's "did the user
-- ever have enough notice for this threshold?" guard. Set only when
-- `scheduledAt` really changes (same transaction); null for calls
-- that have never been rescheduled (cron falls back to `createdAt`).
--
-- Additive-first: nullable, no default, no backfill. Existing rows
-- keep NULL; the service layer treats NULL as "use createdAt".
ALTER TABLE "ClientCall" ADD COLUMN "rescheduledAt" TIMESTAMP(3);
