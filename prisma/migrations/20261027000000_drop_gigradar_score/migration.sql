-- Drop the legacy `gigRadarScore` column from JobPost. The GigRadar
-- source has been retired; the column is unused by every active
-- scanner path (vibe-worker, demo seed).
ALTER TABLE "JobPost" DROP COLUMN IF EXISTS "gigRadarScore";
