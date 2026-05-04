-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('Draft', 'Sent', 'Viewed', 'Replied');

-- CreateEnum
CREATE TYPE "ProposalType" AS ENUM ('Bid', 'Invite', 'DirectMessage');

-- CreateEnum
CREATE TYPE "ProposalSource" AS ENUM ('telegram', 'manual');

-- CreateEnum
CREATE TYPE "JobPostStatus" AS ENUM ('NEW', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobPostDecision" AS ENUM ('approve', 'maybe', 'decline');

-- CreateEnum
CREATE TYPE "JobPostPriority" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "PromptType" AS ENUM ('JOB_GATEKEEPER', 'JOB_EVALUATION', 'CHAT_SYSTEM', 'CHAT_FALLBACK', 'CHAT_CLASSIFIER', 'CHAT_SUMMARY', 'KNOWLEDGE_TITLE_FILTER', 'KNOWLEDGE_CONTENT_FILTER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('conversation_ongoing', 'trial', 'hold', 'contract_offer', 'accept_contract', 'start_contract', 'suspended');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('individual', 'company');

-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('client', 'contractor');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'open', 'paid');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('JOB_POST_MATCH', 'CLIENT_REQUEST', 'CALL_REMINDER');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('DISCORD');

-- CreateEnum
CREATE TYPE "ClientRequestStatus" AS ENUM ('on_review', 'conversation_ongoing', 'archived');

-- CreateEnum
CREATE TYPE "ClientCallClientType" AS ENUM ('lead', 'client_request');

-- CreateEnum
CREATE TYPE "ClientCallStatus" AS ENUM ('scheduled', 'cancelled', 'completed');

-- CreateEnum
CREATE TYPE "CallReminderType" AS ENUM ('min60', 'min10');

-- CreateEnum
CREATE TYPE "SettingType" AS ENUM ('string', 'number', 'boolean', 'json');

-- CreateEnum
CREATE TYPE "SettingUIType" AS ENUM ('input', 'textarea', 'select', 'toggle', 'password');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Platform" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Platform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "jobUrl" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'Draft',
    "platformId" TEXT,
    "proposalType" "ProposalType" NOT NULL,
    "boosted" BOOLEAN NOT NULL DEFAULT false,
    "connects" INTEGER NOT NULL DEFAULT 0,
    "boostedConnects" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "coverLetter" TEXT,
    "vacancy" TEXT,
    "accountId" TEXT,
    "userId" TEXT NOT NULL,
    "source" "ProposalSource" NOT NULL DEFAULT 'manual',
    "jobPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "decision" TEXT,
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSummary" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "proposalId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'conversation_ongoing',
    "clientType" "ClientType",
    "rate" INTEGER,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "holdAt" TIMESTAMP(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "info" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "header" TEXT NOT NULL DEFAULT 'INVOICE',
    "logoUrl" TEXT,
    "number" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "date" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "poNumber" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "shipTo" TEXT,
    "notes" TEXT,
    "terms" TEXT,
    "tax" DECIMAL(10,2),
    "discounts" DECIMAL(10,2),
    "shipping" DECIMAL(10,2),
    "amountPaid" DECIMAL(10,2),
    "showTax" BOOLEAN NOT NULL DEFAULT false,
    "showDiscounts" BOOLEAN NOT NULL DEFAULT false,
    "showShipping" BOOLEAN NOT NULL DEFAULT false,
    "showShipTo" BOOLEAN NOT NULL DEFAULT false,
    "pdfUrl" TEXT,
    "labels" JSONB NOT NULL DEFAULT '{}',
    "customFields" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(10,3) NOT NULL DEFAULT 1,
    "unitCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "CallReminderSent" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "type" "CallReminderType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallReminderSent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingSection" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "type" "SettingType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "defaultValue" JSONB,
    "uiType" "SettingUIType" NOT NULL,
    "options" JSONB,
    "validationSchema" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingValue" (
    "id" TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettingValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Platform_slug_key" ON "Platform"("slug");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_jobPostId_key" ON "Proposal"("jobPostId");

-- CreateIndex
CREATE INDEX "Proposal_createdAt_idx" ON "Proposal"("createdAt");

-- CreateIndex
CREATE INDEX "Proposal_userId_idx" ON "Proposal"("userId");

-- CreateIndex
CREATE INDEX "Proposal_status_idx" ON "Proposal"("status");

-- CreateIndex
CREATE INDEX "JobPost_status_idx" ON "JobPost"("status");

-- CreateIndex
CREATE INDEX "JobPost_decision_idx" ON "JobPost"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "JobPost_chatId_messageId_key" ON "JobPost"("chatId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_proposalId_key" ON "Chat"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_leadId_key" ON "Chat"("leadId");

-- CreateIndex
CREATE INDEX "ChatMessage_chatId_createdAt_idx" ON "ChatMessage"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_category_idx" ON "KnowledgeDocument"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ChatSummary_chatId_key" ON "ChatSummary"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_number_key" ON "Lead"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_proposalId_key" ON "Lead"("proposalId");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_createdAt_idx" ON "Lead"("createdAt");

-- CreateIndex
CREATE INDEX "Prompt_type_idx" ON "Prompt"("type");

-- CreateIndex
CREATE INDEX "Counterparty_type_idx" ON "Counterparty"("type");

-- CreateIndex
CREATE INDEX "Invoice_counterpartyId_idx" ON "Invoice"("counterpartyId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_createdAt_idx" ON "Invoice"("createdAt");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_invoiceId_idx" ON "InvoiceLineItem"("invoiceId");

-- CreateIndex
CREATE INDEX "NotificationEvent_type_createdAt_idx" ON "NotificationEvent"("type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "NotificationDelivery_eventId_idx" ON "NotificationDelivery"("eventId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_channel_status_idx" ON "NotificationDelivery"("channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_eventId_channel_key" ON "NotificationDelivery"("eventId", "channel");

-- CreateIndex
CREATE INDEX "ClientRequest_createdAt_idx" ON "ClientRequest"("createdAt");

-- CreateIndex
CREATE INDEX "ClientRequest_status_idx" ON "ClientRequest"("status");

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

-- CreateIndex
CREATE UNIQUE INDEX "CallReminderSent_callId_type_key" ON "CallReminderSent"("callId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SettingSection_key_key" ON "SettingSection"("key");

-- CreateIndex
CREATE INDEX "SettingSection_order_idx" ON "SettingSection"("order");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- CreateIndex
CREATE INDEX "Setting_sectionId_idx" ON "Setting"("sectionId");

-- CreateIndex
CREATE INDEX "Setting_isActive_idx" ON "Setting"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SettingValue_settingId_key" ON "SettingValue"("settingId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_jobPostId_fkey" FOREIGN KEY ("jobPostId") REFERENCES "JobPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSummary" ADD CONSTRAINT "ChatSummary_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_clientRequestId_fkey" FOREIGN KEY ("clientRequestId") REFERENCES "ClientRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientCall" ADD CONSTRAINT "ClientCall_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallReminderSent" ADD CONSTRAINT "CallReminderSent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "ClientCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "SettingSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettingValue" ADD CONSTRAINT "SettingValue_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "Setting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
