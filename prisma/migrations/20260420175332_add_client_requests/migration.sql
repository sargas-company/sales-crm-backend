-- CreateEnum
CREATE TYPE "ClientRequestStatus" AS ENUM ('on_review', 'conversation_ongoing', 'archived');

-- CreateTable
CREATE TABLE "ClientRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "phoneCountry" TEXT,
    "message" TEXT,
    "services" TEXT[],
    "status" "ClientRequestStatus" NOT NULL DEFAULT 'on_review',
    "files" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientRequest_createdAt_idx" ON "ClientRequest"("createdAt");

-- CreateIndex
CREATE INDEX "ClientRequest_status_idx" ON "ClientRequest"("status");
