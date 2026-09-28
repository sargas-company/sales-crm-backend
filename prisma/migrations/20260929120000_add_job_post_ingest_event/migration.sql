-- Scanner Core phase 1 — capture-first Vibe Worker webhook.
-- Strictly ADDITIVE:
--   * two new enums   (JobPostIngestSource, JobPostIngestStatus)
--   * one new table   (JobPostIngestEvent)
--   * one new FK      (JobPostIngestEvent.jobPostId → JobPost.id  ON DELETE SET NULL)
-- No existing table, column, enum, index, or FK is dropped, renamed, or
-- altered. Safe to apply on any database that already has the JobPost
-- table (introduced by 20260421140310_add_posts_staging and preserved
-- through legacy-cleanup).

CREATE TYPE "JobPostIngestSource" AS ENUM ('VIBE_WORKER');
CREATE TYPE "JobPostIngestStatus" AS ENUM ('RECEIVED');

CREATE TABLE "JobPostIngestEvent" (
  "id"             TEXT NOT NULL,
  "source"         "JobPostIngestSource" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload"        JSONB NOT NULL,
  "status"         "JobPostIngestStatus" NOT NULL DEFAULT 'RECEIVED',
  "error"          TEXT,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "receivedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"    TIMESTAMP(3),
  "jobPostId"      TEXT,
  CONSTRAINT "JobPostIngestEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobPostIngestEvent_idempotencyKey_key"
  ON "JobPostIngestEvent"("idempotencyKey");

CREATE INDEX "JobPostIngestEvent_source_receivedAt_idx"
  ON "JobPostIngestEvent"("source", "receivedAt");

CREATE INDEX "JobPostIngestEvent_status_idx"
  ON "JobPostIngestEvent"("status");

CREATE INDEX "JobPostIngestEvent_jobPostId_idx"
  ON "JobPostIngestEvent"("jobPostId");

ALTER TABLE "JobPostIngestEvent"
  ADD CONSTRAINT "JobPostIngestEvent_jobPostId_fkey"
  FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
