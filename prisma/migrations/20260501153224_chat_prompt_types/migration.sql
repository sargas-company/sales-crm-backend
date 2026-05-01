-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PromptType" ADD VALUE 'CHAT_CLASSIFIER';
ALTER TYPE "PromptType" ADD VALUE 'CHAT_SUMMARY';
ALTER TYPE "PromptType" ADD VALUE 'KNOWLEDGE_TITLE_FILTER';
ALTER TYPE "PromptType" ADD VALUE 'KNOWLEDGE_CONTENT_FILTER';
