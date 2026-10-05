-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "actorEmail" TEXT,
ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
ADD COLUMN     "changes" JSONB,
ADD COLUMN     "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
ADD COLUMN     "targetHref" TEXT;

-- AlterTable
ALTER TABLE "CredentialAccount" ALTER COLUMN "tags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "CredentialProfile" ALTER COLUMN "tags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "UserMfaCredential" ALTER COLUMN "transports" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "AuditEvent_result_occurredAt_idx" ON "AuditEvent"("result", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_severity_occurredAt_idx" ON "AuditEvent"("severity", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_domain_action_occurredAt_idx" ON "AuditEvent"("domain", "action", "occurredAt");
