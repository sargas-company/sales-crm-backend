-- Scanner Core: Vibe Worker ingest → JobPost bridge.
--
-- Three non-destructive changes:
--
-- 1. Extend `JobPostIngestStatus` enum with the states the processor
--    needs to transition into (PROCESSED / FAILED / SKIPPED). Existing
--    `RECEIVED` rows stay valid.
-- 2. Loosen `JobPost.chatId` / `JobPost.messageId` to NULLable so the
--    Scanner Core path (which has no Telegram chat context) can create
--    rows. The existing `(chatId, messageId)` unique index remains —
--    Postgres treats NULLs as non-equal, so legacy Telegram
--    semantics still hold and Vibe rows never collide on it.
-- 3. Add `JobPost.providerJobId` + a UNIQUE index. This is the real
--    idempotency anchor for the Vibe path: one JobPost per vacancy
--    identifier returned by Vibe Worker.
ALTER TYPE "JobPostIngestStatus" ADD VALUE IF NOT EXISTS 'PROCESSED';
ALTER TYPE "JobPostIngestStatus" ADD VALUE IF NOT EXISTS 'FAILED';
ALTER TYPE "JobPostIngestStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TABLE "JobPost"
    ALTER COLUMN "chatId" DROP NOT NULL,
    ALTER COLUMN "messageId" DROP NOT NULL;

ALTER TABLE "JobPost"
    ADD COLUMN "providerJobId" TEXT NULL;

CREATE UNIQUE INDEX "JobPost_providerJobId_key"
    ON "JobPost" ("providerJobId");
