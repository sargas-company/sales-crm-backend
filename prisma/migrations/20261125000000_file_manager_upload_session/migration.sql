-- CreateEnum
CREATE TYPE "FileManagerUploadStatus" AS ENUM ('OPEN', 'FINALIZED', 'ABORTED');

-- CreateTable
CREATE TABLE "FileManagerUploadSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "folderId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha1" TEXT NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "partsReceived" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "partSha1s" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "storageKey" TEXT NOT NULL,
    "b2FileId" TEXT NOT NULL,
    "status" "FileManagerUploadStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileManagerUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileManagerUploadSession_userId_status_idx" ON "FileManagerUploadSession"("userId", "status");

-- CreateIndex
CREATE INDEX "FileManagerUploadSession_expiresAt_idx" ON "FileManagerUploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "FileManagerUploadSession_status_idx" ON "FileManagerUploadSession"("status");

-- AddForeignKey
ALTER TABLE "FileManagerUploadSession" ADD CONSTRAINT "FileManagerUploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
