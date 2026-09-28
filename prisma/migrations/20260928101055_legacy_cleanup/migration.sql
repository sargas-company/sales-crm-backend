-- legacy_cleanup migration
-- Drops the chat / knowledge / translation / telegram schema surfaces after
-- T-04 removed every frontend consumer and T-05 removes every backend
-- consumer. Order:
--   1. Delete Prompt rows for chat / knowledge types (frees the enum for the
--      rename-swap in step 6).
--   2. Delete Setting rows for job_scanner.telegram.* / job_scanner.backfill.*
--      (SettingValue rows cascade via FK).
--   3. Drop the chat + knowledge tables in FK-safe order.
--   4. Drop translation / message / chat enums after the tables that used them.
--   5. Rebuild the PromptType enum to just JOB_GATEKEEPER + JOB_EVALUATION.
--   6. Drop the pgvector extension (nothing uses it after this migration).

-- 1. Delete legacy Prompt rows so the PromptType enum rebuild in step 5 is safe.
DELETE FROM "Prompt"
WHERE "type" IN (
  'CHAT_SYSTEM',
  'CHAT_FALLBACK',
  'CHAT_SUMMARY',
  'CHAT_GATE',
  'CHAT_SELECTOR',
  'CHAT_CLASSIFIER',
  'KNOWLEDGE_TITLE_FILTER',
  'KNOWLEDGE_CONTENT_FILTER'
);

-- 2. Delete legacy Setting rows (telegram + backfill scanner keys). SettingValue
--    rows cascade via ON DELETE CASCADE on Setting.
DELETE FROM "Setting"
WHERE "key" LIKE 'job_scanner.telegram.%'
   OR "key" LIKE 'job_scanner.backfill.%';

-- 3. Drop the chat + knowledge tables in FK order. `Chat.proposalId` and
--    `Chat.leadId` are the only FKs pointing at Proposal / Lead, so dropping
--    the Chat table itself releases both relations without needing an
--    explicit column drop on Proposal / Lead (the schema already had those
--    relation columns on the Chat side, not on Proposal / Lead).
DROP TABLE IF EXISTS "MessageTranslation";
DROP TABLE IF EXISTS "MessageAttachment";
DROP TABLE IF EXISTS "ChatSummary";
DROP TABLE IF EXISTS "ChatMessage";
DROP TABLE IF EXISTS "Chat";
DROP TABLE IF EXISTS "KnowledgeDocument";

-- 4. Drop enums that only the dropped tables referenced.
DROP TYPE IF EXISTS "MessageAttachmentStatus";
DROP TYPE IF EXISTS "ChatMessageStatus";
DROP TYPE IF EXISTS "TranslationLanguage";
DROP TYPE IF EXISTS "TranslationProvider";
DROP TYPE IF EXISTS "MessageRole";

-- 5. Rebuild the PromptType enum. Postgres cannot DROP VALUE from an enum
--    while any row still references it, so we swap the type out for a fresh
--    two-value enum. Safe because step 1 cleared every row that referenced
--    the values we are dropping.
ALTER TYPE "PromptType" RENAME TO "PromptType_old";
CREATE TYPE "PromptType" AS ENUM ('JOB_GATEKEEPER', 'JOB_EVALUATION');
ALTER TABLE "Prompt"
  ALTER COLUMN "type" TYPE "PromptType"
  USING "type"::text::"PromptType";
DROP TYPE "PromptType_old";

-- 6. Drop the pgvector extension. Nothing in the current schema uses it after
--    KnowledgeDocument (embedding column, historical) is gone.
DROP EXTENSION IF EXISTS vector;
