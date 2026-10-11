-- Extend NotificationType enum with the three new Call-related
-- events used by the Sales section. Added to the END of the enum
-- so existing ordering is preserved.
ALTER TYPE "NotificationType" ADD VALUE 'CALL_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'CALL_RESCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'CALL_CANCELLED';
