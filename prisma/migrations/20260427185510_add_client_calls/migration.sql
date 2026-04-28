-- CreateEnum
CREATE TYPE "ClientCallClientType" AS ENUM ('lead', 'client_request');

-- CreateEnum
CREATE TYPE "ClientCallStatus" AS ENUM ('scheduled', 'cancelled', 'completed');

-- CreateTable
CREATE TABLE "ClientCall" (
    "id" TEXT NOT NULL,
    "clientType" "ClientCallClientType" NOT NULL,
    "leadId" TEXT,
    "clientRequestId" TEXT,
    "createdById" TEXT NOT NULL,
    "callTitle" TEXT NOT NULL,
    "meetingUrl" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "clientTimezone" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "status" "ClientCallStatus" NOT NULL DEFAULT 'scheduled',
    "notes" TEXT,
    "summary" TEXT,
    "transcriptUrl" TEXT,
    "aiSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientCall_createdById_idx" ON "ClientCall"("createdById");

-- CreateIndex
CREATE INDEX "ClientCall_status_idx" ON "ClientCall"("status");

-- CreateIndex
CREATE INDEX "ClientCall_scheduledAt_idx" ON "ClientCall"("scheduledAt" DESC);

-- CreateIndex
CREATE INDEX "ClientCall_leadId_idx" ON "ClientCall"("leadId");

-- CreateIndex
CREATE INDEX "ClientCall_clientRequestId_idx" ON "ClientCall"("clientRequestId");

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_clientRequestId_fkey" FOREIGN KEY ("clientRequestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
