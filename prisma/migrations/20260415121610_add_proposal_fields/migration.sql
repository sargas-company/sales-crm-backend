/*
  Warnings:

  - You are about to drop the column `title` on the `Proposal` table. All the data in the column will be lost.
  - Added the required column `account` to the `Proposal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `manager` to the `Proposal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `proposalType` to the `Proposal` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('Draft', 'Sent', 'Viewed', 'Replied');

-- CreateEnum
CREATE TYPE "ProposalType" AS ENUM ('Bid', 'Invite', 'DirectMessage');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('Upwork', 'LinkedIn');

-- DropIndex
DROP INDEX "base_knowledge_embedding_idx";

-- AlterTable
ALTER TABLE "Proposal" DROP COLUMN "title",
ADD COLUMN     "account" TEXT NOT NULL,
ADD COLUMN     "boosted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "connects" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "coverLetter" TEXT,
ADD COLUMN     "jobUrl" TEXT,
ADD COLUMN     "manager" TEXT NOT NULL,
ADD COLUMN     "platform" "Platform" NOT NULL DEFAULT 'Upwork',
ADD COLUMN     "proposalType" "ProposalType" NOT NULL,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "status" "ProposalStatus" NOT NULL DEFAULT 'Draft';

-- CreateIndex
CREATE INDEX "Proposal_status_idx" ON "Proposal"("status");
