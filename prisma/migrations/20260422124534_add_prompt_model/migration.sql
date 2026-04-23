/*
  Warnings:

  - You are about to drop the `Settings` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PromptType" AS ENUM ('JOB_GATEKEEPER', 'JOB_EVALUATION', 'CHAT_SYSTEM', 'CHAT_FALLBACK');

-- DropTable
DROP TABLE "Settings";

-- CreateTable
CREATE TABLE "Prompt" (
    "id" TEXT NOT NULL,
    "type" "PromptType" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Prompt_type_idx" ON "Prompt"("type");

CREATE UNIQUE INDEX unique_active_prompt_per_type
ON "Prompt"("type")
WHERE "isActive" = true;