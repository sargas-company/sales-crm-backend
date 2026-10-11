-- Phase A for Job Posts production-ready work:
--   1. JobPostStatus += SKIPPED (user explicitly declined to analyse
--      a backlog item, or operator chose "New posts only" on enable).
--   2. Additional normalised columns pulled out of rawPayload so the
--      list / detail / filters stop depending on Vibe webhook JSON
--      structure. Every column nullable so existing rows keep working;
--      a backfill script (not run here) can populate them later.
--   3. Analysis bookkeeping columns (`analysisAttempts`,
--      `lastAnalysisError`, `lastAnalysisAt`, `analysisModelVersion`)
--      so the processor can retry transient failures with bounded
--      attempts and surface a sanitised reason to the UI.
--   4. Supplemental indices for the new list surface.
--
-- Fully additive. No existing JobPost / JobPostView / Proposal /
-- JobPostIngestEvent row is touched.

-- 1. Enum extension — SKIPPED
ALTER TYPE "JobPostStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- 2. Normalised payload fields
ALTER TABLE "JobPost"
  ADD COLUMN "budgetType"               TEXT,
  ADD COLUMN "budgetMin"                DOUBLE PRECISION,
  ADD COLUMN "budgetMax"                DOUBLE PRECISION,
  ADD COLUMN "budgetCurrency"           TEXT,
  ADD COLUMN "postedAt"                 TIMESTAMP(3),
  ADD COLUMN "contractType"             TEXT,
  ADD COLUMN "duration"                 TEXT,
  ADD COLUMN "hoursPerWeek"             TEXT,
  ADD COLUMN "experienceLevel"          TEXT,
  ADD COLUMN "connectsRequired"         INTEGER,
  ADD COLUMN "categories"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "questions"                JSONB,
  ADD COLUMN "country"                  TEXT,
  ADD COLUMN "city"                     TEXT,
  ADD COLUMN "clientPaymentVerified"    BOOLEAN,
  ADD COLUMN "clientRating"             DOUBLE PRECISION,
  ADD COLUMN "clientHires"              INTEGER,
  ADD COLUMN "clientJobsPosted"         INTEGER,
  ADD COLUMN "clientReviewCount"        INTEGER,
  ADD COLUMN "clientRankLabel"          TEXT,
  ADD COLUMN "clientRankScore"          DOUBLE PRECISION,
  ADD COLUMN "clientLocationRestriction" TEXT;

-- 3. Analysis bookkeeping
ALTER TABLE "JobPost"
  ADD COLUMN "analysisAttempts"         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAnalysisError"        TEXT,
  ADD COLUMN "lastAnalysisAt"           TIMESTAMP(3),
  ADD COLUMN "analysisModelVersion"     TEXT,
  ADD COLUMN "enqueuedAt"               TIMESTAMP(3);

-- 4. Supplemental indices for the triage list
CREATE INDEX IF NOT EXISTS "JobPost_status_createdAt_idx"
  ON "JobPost"("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "JobPost_decision_createdAt_idx"
  ON "JobPost"("decision", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "JobPost_country_idx"
  ON "JobPost"("country");
CREATE INDEX IF NOT EXISTS "JobPost_budgetType_idx"
  ON "JobPost"("budgetType");
