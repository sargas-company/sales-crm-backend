-- Add SKIPPED to NotificationDeliveryStatus so job-post alerts gated by
-- `scanner.discordAlertsEnabled` or `scanner.discordScoreThreshold` can
-- write a terminal delivery row (instead of leaving the event as an
-- orphan that orphan-recovery replays as soon as alerts flip on).
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';
