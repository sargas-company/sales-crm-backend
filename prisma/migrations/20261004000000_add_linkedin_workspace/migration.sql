-- LinkedIn Workspace: Accounts, Ideas, Posts
--
-- Manual MVP: directory of accounts we publish from, Ideas bank, Posts
-- with hand-entered performance metrics. No LinkedIn API integration.

CREATE TYPE "LinkedInAccountType" AS ENUM ('PERSONAL', 'COMPANY');

CREATE TYPE "LinkedInIdeaStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'CONVERTED', 'ARCHIVED');

CREATE TYPE "LinkedInIdeaPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TYPE "LinkedInPostFormat" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LINK', 'POLL');

CREATE TYPE "LinkedInPostStatus" AS ENUM ('DRAFT', 'READY', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "LinkedInAccount" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "type" "LinkedInAccountType" NOT NULL,
    "profileUrl" TEXT NOT NULL,
    "employeeId" TEXT,
    "avatarUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LinkedInAccount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LinkedInAccount_type_idx" ON "LinkedInAccount"("type");
CREATE INDEX "LinkedInAccount_isActive_idx" ON "LinkedInAccount"("isActive");
CREATE INDEX "LinkedInAccount_employeeId_idx" ON "LinkedInAccount"("employeeId");

ALTER TABLE "LinkedInAccount"
    ADD CONSTRAINT "LinkedInAccount_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LinkedInIdea" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "hook" TEXT,
    "targetAudience" TEXT,
    "contentPillar" TEXT,
    "suggestedFormat" "LinkedInPostFormat",
    "language" TEXT NOT NULL DEFAULT 'en',
    "priority" "LinkedInIdeaPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "LinkedInIdeaStatus" NOT NULL DEFAULT 'NEW',
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "referenceLinks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "attachments" JSONB,
    "ownerId" TEXT,
    "plannedDate" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LinkedInIdea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LinkedInIdea_status_idx" ON "LinkedInIdea"("status");
CREATE INDEX "LinkedInIdea_priority_idx" ON "LinkedInIdea"("priority");
CREATE INDEX "LinkedInIdea_language_idx" ON "LinkedInIdea"("language");
CREATE INDEX "LinkedInIdea_plannedDate_idx" ON "LinkedInIdea"("plannedDate");

ALTER TABLE "LinkedInIdea"
    ADD CONSTRAINT "LinkedInIdea_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LinkedInPost" (
    "id" TEXT NOT NULL,
    "internalTitle" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ideaId" TEXT,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "hook" TEXT,
    "firstComment" TEXT,
    "hashtags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "format" "LinkedInPostFormat" NOT NULL DEFAULT 'TEXT',
    "language" TEXT NOT NULL DEFAULT 'en',
    "targetAudience" TEXT,
    "contentPillar" TEXT,
    "attachments" JSONB,
    "externalLink" TEXT,
    "status" "LinkedInPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "linkedInUrl" TEXT,
    "note" TEXT,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reactions" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "reposts" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "followersGained" INTEGER NOT NULL DEFAULT 0,
    "leadsGenerated" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LinkedInPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LinkedInPost_accountId_idx" ON "LinkedInPost"("accountId");
CREATE INDEX "LinkedInPost_ideaId_idx" ON "LinkedInPost"("ideaId");
CREATE INDEX "LinkedInPost_status_idx" ON "LinkedInPost"("status");
CREATE INDEX "LinkedInPost_format_idx" ON "LinkedInPost"("format");
CREATE INDEX "LinkedInPost_scheduledAt_idx" ON "LinkedInPost"("scheduledAt");
CREATE INDEX "LinkedInPost_publishedAt_idx" ON "LinkedInPost"("publishedAt");

ALTER TABLE "LinkedInPost"
    ADD CONSTRAINT "LinkedInPost_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "LinkedInAccount"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LinkedInPost"
    ADD CONSTRAINT "LinkedInPost_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "LinkedInIdea"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LinkedInPost"
    ADD CONSTRAINT "LinkedInPost_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Permission catalogue: 12 keys for LinkedIn workspace (owner picks up
-- via existing role catalogue sync; admin_manager preset updated in
-- seed.ts).
INSERT INTO "Permission" (id, module, action, key, label, "createdAt")
VALUES
    (gen_random_uuid(), 'linkedin_accounts', 'view',   'linkedin_accounts:view',   'View LinkedIn accounts',   now()),
    (gen_random_uuid(), 'linkedin_accounts', 'create', 'linkedin_accounts:create', 'Create LinkedIn accounts', now()),
    (gen_random_uuid(), 'linkedin_accounts', 'update', 'linkedin_accounts:update', 'Update LinkedIn accounts', now()),
    (gen_random_uuid(), 'linkedin_accounts', 'delete', 'linkedin_accounts:delete', 'Delete LinkedIn accounts', now()),
    (gen_random_uuid(), 'linkedin_ideas',    'view',   'linkedin_ideas:view',      'View LinkedIn ideas',      now()),
    (gen_random_uuid(), 'linkedin_ideas',    'create', 'linkedin_ideas:create',    'Create LinkedIn ideas',    now()),
    (gen_random_uuid(), 'linkedin_ideas',    'update', 'linkedin_ideas:update',    'Update LinkedIn ideas',    now()),
    (gen_random_uuid(), 'linkedin_ideas',    'delete', 'linkedin_ideas:delete',    'Delete LinkedIn ideas',    now()),
    (gen_random_uuid(), 'linkedin_posts',    'view',   'linkedin_posts:view',      'View LinkedIn posts',      now()),
    (gen_random_uuid(), 'linkedin_posts',    'create', 'linkedin_posts:create',    'Create LinkedIn posts',    now()),
    (gen_random_uuid(), 'linkedin_posts',    'update', 'linkedin_posts:update',    'Update LinkedIn posts',    now()),
    (gen_random_uuid(), 'linkedin_posts',    'delete', 'linkedin_posts:delete',    'Delete LinkedIn posts',    now())
ON CONFLICT (key) DO NOTHING;
