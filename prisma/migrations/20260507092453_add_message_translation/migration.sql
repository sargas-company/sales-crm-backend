-- CreateEnum
CREATE TYPE "TranslationLanguage" AS ENUM ('RU', 'UK');

-- CreateEnum
CREATE TYPE "TranslationProvider" AS ENUM ('DEEPL');

-- CreateTable
CREATE TABLE "MessageTranslation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "targetLanguage" "TranslationLanguage" NOT NULL,
    "content" TEXT NOT NULL,
    "sourceLanguage" TEXT,
    "provider" "TranslationProvider" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTranslation_messageId_idx" ON "MessageTranslation"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTranslation_messageId_targetLanguage_key" ON "MessageTranslation"("messageId", "targetLanguage");

-- AddForeignKey
ALTER TABLE "MessageTranslation" ADD CONSTRAINT "MessageTranslation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
