-- CreateEnum
CREATE TYPE "FileManagerShareResourceType" AS ENUM ('FOLDER', 'FILE');

-- AlterTable — User gets portal fields.
-- Written in expand-then-contract shape so the gateway's additive
-- allowlist is satisfied: each column is first ADDed as nullable
-- with a DEFAULT, then backfilled, then flipped to NOT NULL.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "active" BOOLEAN DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "discordId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "displayName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isPortalUser" BOOLEAN DEFAULT false;

-- Backfill existing rows so SET NOT NULL below cannot fail.
UPDATE "User" SET "active" = true WHERE "active" IS NULL;
UPDATE "User" SET "isPortalUser" = false WHERE "isPortalUser" IS NULL;

-- Lock in NOT NULL now that every row has a value.
ALTER TABLE "User" ALTER COLUMN "active" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "isPortalUser" SET NOT NULL;

-- Allow nullable passwordHash (portal users have no password).
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "FileManagerShare" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resourceType" "FileManagerShareResourceType" NOT NULL,
    "resourceId" TEXT NOT NULL,
    "recursive" BOOLEAN NOT NULL DEFAULT false,
    "canDownload" BOOLEAN NOT NULL DEFAULT true,
    "canUpload" BOOLEAN NOT NULL DEFAULT false,
    "canCreateSubfolders" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileManagerShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileManagerInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sharesJson" JSONB NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileManagerInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileManagerShare_userId_idx" ON "FileManagerShare"("userId");

-- CreateIndex
CREATE INDEX "FileManagerShare_resourceType_resourceId_idx" ON "FileManagerShare"("resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FileManagerShare_userId_resourceType_resourceId_key" ON "FileManagerShare"("userId", "resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FileManagerInvite_token_key" ON "FileManagerInvite"("token");

-- CreateIndex
CREATE INDEX "FileManagerInvite_createdById_idx" ON "FileManagerInvite"("createdById");

-- CreateIndex
CREATE INDEX "FileManagerInvite_usedByUserId_idx" ON "FileManagerInvite"("usedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

-- AddForeignKey
ALTER TABLE "FileManagerShare" ADD CONSTRAINT "FileManagerShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileManagerShare" ADD CONSTRAINT "FileManagerShare_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileManagerInvite" ADD CONSTRAINT "FileManagerInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileManagerInvite" ADD CONSTRAINT "FileManagerInvite_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
