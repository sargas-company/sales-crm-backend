-- Two profile tiers: primary (vitrine, strict reminder cadence) and
-- secondary (worker profiles, light-touch monthly cadence). Defaults
-- to secondary; owner promotes primary profiles via the UI.

CREATE TYPE "UpworkProfileTier" AS ENUM ('primary', 'secondary');

ALTER TABLE "UpworkProfile"
  ADD COLUMN "tier" "UpworkProfileTier" NOT NULL DEFAULT 'secondary';

CREATE INDEX "UpworkProfile_tier_idx" ON "UpworkProfile"("tier");
