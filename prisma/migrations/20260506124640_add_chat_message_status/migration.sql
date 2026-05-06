/*
  Warnings:

  - The values [TIMEOUT] on the enum `MessageAttachmentStatus` will be removed. If these variants are still used in the database, this will fail.
  - Added the required column `updatedAt` to the `ChatMessage` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('PREPARING_ATTACHMENTS', 'PARTIAL_READY', 'READY_FOR_AI', 'AI_PROCESSING', 'DONE', 'FAILED');

-- AlterEnum
BEGIN;
CREATE TYPE "MessageAttachmentStatus_new" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');
ALTER TABLE "public"."MessageAttachment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "MessageAttachment" ALTER COLUMN "status" TYPE "MessageAttachmentStatus_new" USING ("status"::text::"MessageAttachmentStatus_new");
ALTER TYPE "MessageAttachmentStatus" RENAME TO "MessageAttachmentStatus_old";
ALTER TYPE "MessageAttachmentStatus_new" RENAME TO "MessageAttachmentStatus";
DROP TYPE "public"."MessageAttachmentStatus_old";
ALTER TABLE "MessageAttachment" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "status" "ChatMessageStatus" NOT NULL DEFAULT 'PREPARING_ATTACHMENTS',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "ChatMessage_status_updatedAt_idx" ON "ChatMessage"("status", "updatedAt");
