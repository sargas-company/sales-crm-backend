-- DiscordProfile: nullable salesChannelId for lead/sales notifications.
-- Non-destructive: nullable column, no backfill needed.
ALTER TABLE "DiscordProfile"
  ADD COLUMN "salesChannelId" TEXT NULL;
