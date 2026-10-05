-- CreateEnum
CREATE TYPE "PhoneOperator" AS ENUM ('VODAFONE', 'KYIVSTAR', 'LIFECELL', 'OTHER');

-- CreateEnum
CREATE TYPE "PhoneStatus" AS ENUM ('ACTIVE', 'HOLD', 'DISABLED');

-- CreateEnum
CREATE TYPE "PhoneMaintenanceStatus" AS ENUM ('DUE', 'OVERDUE', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PortfolioStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PortfolioAssetKind" AS ENUM ('COVER', 'IMAGE', 'FILE');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('DAILY', 'PRE_MIGRATION', 'PRE_SEED', 'MANUAL');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'VERIFIED');

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "operator" "PhoneOperator" NOT NULL DEFAULT 'OTHER',
    "status" "PhoneStatus" NOT NULL DEFAULT 'ACTIVE',
    "holderEmployeeId" TEXT,
    "maintenanceRequired" BOOLEAN NOT NULL DEFAULT true,
    "lastTopUpAt" TIMESTAMP(3),
    "lastNetworkRegistrationAt" TIMESTAMP(3),
    "nextMaintenanceAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumberBinding" (
    "id" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "credentialProfileId" TEXT,
    "status" "PhoneStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumberBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneMaintenance" (
    "id" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "PhoneMaintenanceStatus" NOT NULL DEFAULT 'DUE',
    "networkRegisteredAt" TIMESTAMP(3),
    "toppedUpAt" TIMESTAMP(3),
    "topUpAmount" DECIMAL(10,2),
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneReminderLog" (
    "id" TEXT NOT NULL,
    "sentOn" DATE NOT NULL,
    "taskCount" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioItem" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortSummary" TEXT,
    "status" "PortfolioStatus" NOT NULL DEFAULT 'DRAFT',
    "isNda" BOOLEAN NOT NULL DEFAULT false,
    "contentMarkdown" TEXT NOT NULL DEFAULT '',
    "coverAssetId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioTag" (
    "id" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioItemTag" (
    "itemId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "PortfolioItemTag_pkey" PRIMARY KEY ("itemId","tagId")
);

-- CreateTable
CREATE TABLE "PortfolioAsset" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "kind" "PortfolioAssetKind" NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "type" "BackupType" NOT NULL,
    "status" "BackupStatus" NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "databaseName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "artifactKey" TEXT,
    "manifestKey" TEXT,
    "size" BIGINT,
    "checksum" TEXT,
    "checksumAlgo" TEXT DEFAULT 'sha256',
    "pgVersion" TEXT,
    "gitSha" TEXT,
    "migrationName" TEXT,
    "triggeredBy" TEXT,
    "errorMessage" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_number_key" ON "PhoneNumber"("number");

-- CreateIndex
CREATE INDEX "PhoneNumber_operator_idx" ON "PhoneNumber"("operator");

-- CreateIndex
CREATE INDEX "PhoneNumber_status_idx" ON "PhoneNumber"("status");

-- CreateIndex
CREATE INDEX "PhoneNumber_maintenanceRequired_nextMaintenanceAt_idx" ON "PhoneNumber"("maintenanceRequired", "nextMaintenanceAt");

-- CreateIndex
CREATE INDEX "PhoneNumberBinding_phoneNumberId_idx" ON "PhoneNumberBinding"("phoneNumberId");

-- CreateIndex
CREATE INDEX "PhoneNumberBinding_serviceName_idx" ON "PhoneNumberBinding"("serviceName");

-- CreateIndex
CREATE INDEX "PhoneNumberBinding_credentialProfileId_idx" ON "PhoneNumberBinding"("credentialProfileId");

-- CreateIndex
CREATE INDEX "PhoneMaintenance_status_dueAt_idx" ON "PhoneMaintenance"("status", "dueAt");

-- CreateIndex
CREATE INDEX "PhoneMaintenance_dueAt_idx" ON "PhoneMaintenance"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneMaintenance_phoneNumberId_dueAt_key" ON "PhoneMaintenance"("phoneNumberId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneReminderLog_sentOn_key" ON "PhoneReminderLog"("sentOn");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioItem_slug_key" ON "PortfolioItem"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioItem_coverAssetId_key" ON "PortfolioItem"("coverAssetId");

-- CreateIndex
CREATE INDEX "PortfolioItem_status_idx" ON "PortfolioItem"("status");

-- CreateIndex
CREATE INDEX "PortfolioItem_isNda_idx" ON "PortfolioItem"("isNda");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioTag_normalized_key" ON "PortfolioTag"("normalized");

-- CreateIndex
CREATE INDEX "PortfolioItemTag_tagId_idx" ON "PortfolioItemTag"("tagId");

-- CreateIndex
CREATE INDEX "PortfolioAsset_itemId_idx" ON "PortfolioAsset"("itemId");

-- CreateIndex
CREATE INDEX "BackupRun_type_startedAt_idx" ON "BackupRun"("type", "startedAt");

-- CreateIndex
CREATE INDEX "BackupRun_status_idx" ON "BackupRun"("status");

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_holderEmployeeId_fkey" FOREIGN KEY ("holderEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumberBinding" ADD CONSTRAINT "PhoneNumberBinding_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumberBinding" ADD CONSTRAINT "PhoneNumberBinding_credentialProfileId_fkey" FOREIGN KEY ("credentialProfileId") REFERENCES "CredentialProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneMaintenance" ADD CONSTRAINT "PhoneMaintenance_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES "PortfolioAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItemTag" ADD CONSTRAINT "PortfolioItemTag_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioItemTag" ADD CONSTRAINT "PortfolioItemTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "PortfolioTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioAsset" ADD CONSTRAINT "PortfolioAsset_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PortfolioItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
