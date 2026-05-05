-- CreateEnum
CREATE TYPE "MessageAttachmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'TIMEOUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PromptType" ADD VALUE 'CHAT_GATE';
ALTER TYPE "PromptType" ADD VALUE 'CHAT_SELECTOR';

-- AlterTable
ALTER TABLE "KnowledgeDocument" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileUrl" TEXT,
    "textRepresentation" TEXT,
    "status" "MessageAttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_idx" ON "MessageAttachment"("messageId");

-- CreateIndex
CREATE INDEX "MessageAttachment_status_idx" ON "MessageAttachment"("status");

-- CreateIndex
CREATE INDEX "MessageAttachment_messageId_status_idx" ON "MessageAttachment"("messageId", "status");

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
