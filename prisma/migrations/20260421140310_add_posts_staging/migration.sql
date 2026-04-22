/*
  Warnings:

  - A unique constraint covering the columns `[jobPostId]` on the table `Proposal` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('telegram', 'manual');

-- CreateEnum
CREATE TYPE "JobPostStatus" AS ENUM ('NEW', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobPostDecision" AS ENUM ('approve', 'maybe', 'decline');

-- CreateEnum
CREATE TYPE "JobPostPriority" AS ENUM ('high', 'medium', 'low');

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "jobPostId" TEXT,
ADD COLUMN     "source" "ProposalSource" NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "JobPost" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "status" "JobPostStatus" NOT NULL DEFAULT 'NEW',
    "decision" "JobPostDecision",
    "matchScore" INTEGER,
    "priority" "JobPostPriority",
    "aiResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "title" TEXT,
    "jobUrl" TEXT,
    "scanner" TEXT,
    "gigRadarScore" INTEGER,
    "location" TEXT,
    "budget" TEXT,
    "totalSpent" DOUBLE PRECISION,
    "avgRatePaid" DOUBLE PRECISION,
    "hireRate" DOUBLE PRECISION,
    "hSkillsKeywords" TEXT[],

    CONSTRAINT "JobPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobPost_status_idx" ON "JobPost"("status");

-- CreateIndex
CREATE INDEX "JobPost_decision_idx" ON "JobPost"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "JobPost_chatId_messageId_key" ON "JobPost"("chatId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_jobPostId_key" ON "Proposal"("jobPostId");

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
