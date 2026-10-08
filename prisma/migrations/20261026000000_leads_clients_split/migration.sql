-- Phase 1: new enums & columns, non-breaking additions

CREATE TYPE "LeadTemperature" AS ENUM ('COLD', 'WARM', 'HOT');
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'FORMER');

ALTER TABLE "Lead"
  ADD COLUMN "source" TEXT,
  ADD COLUMN "profileUrl" TEXT,
  ADD COLUMN "temperature" "LeadTemperature",
  ADD COLUMN "notes" TEXT;

CREATE INDEX "Lead_temperature_idx" ON "Lead"("temperature");
CREATE INDEX "Lead_source_idx" ON "Lead"("source");

-- Phase 2: Lead status rebuild (safe for existing rows via explicit mapping)

CREATE TYPE "LeadStatus_new" AS ENUM (
  'NEW',
  'CONTACTED',
  'IN_CONVERSATION',
  'ON_HOLD',
  'WON',
  'LOST'
);

ALTER TABLE "Lead" ADD COLUMN "status_new" "LeadStatus_new";

UPDATE "Lead" SET "status_new" = CASE "status"::text
  WHEN 'conversation_ongoing' THEN 'IN_CONVERSATION'::"LeadStatus_new"
  WHEN 'trial'                THEN 'IN_CONVERSATION'::"LeadStatus_new"
  WHEN 'hold'                 THEN 'ON_HOLD'::"LeadStatus_new"
  WHEN 'contract_offer'       THEN 'IN_CONVERSATION'::"LeadStatus_new"
  WHEN 'accept_contract'      THEN 'WON'::"LeadStatus_new"
  WHEN 'start_contract'       THEN 'WON'::"LeadStatus_new"
  WHEN 'suspended'            THEN 'LOST'::"LeadStatus_new"
END;

ALTER TABLE "Lead" ALTER COLUMN "status_new" SET NOT NULL;
ALTER TABLE "Lead" ALTER COLUMN "status_new" SET DEFAULT 'NEW';

ALTER TABLE "Lead" DROP COLUMN "status";
ALTER TABLE "Lead" RENAME COLUMN "status_new" TO "status";

DROP TYPE "LeadStatus";
ALTER TYPE "LeadStatus_new" RENAME TO "LeadStatus";

CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- Phase 3: Client model

CREATE TABLE "Client" (
  "id"          TEXT         NOT NULL,
  "firstName"   TEXT         NOT NULL,
  "lastName"    TEXT,
  "company"     TEXT,
  "email"       TEXT,
  "phone"       TEXT,
  "source"      TEXT,
  "profileUrl"  TEXT,
  "status"      "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
  "clientSince" TIMESTAMP(3),
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Client_status_idx"      ON "Client"("status");
CREATE INDEX "Client_source_idx"      ON "Client"("source");
CREATE INDEX "Client_clientSince_idx" ON "Client"("clientSince");
CREATE INDEX "Client_createdAt_idx"   ON "Client"("createdAt");

-- Phase 4: ClientCall — new owner column + enum extension + invariant

ALTER TYPE "ClientCallClientType" ADD VALUE IF NOT EXISTS 'client';

ALTER TABLE "ClientCall" ADD COLUMN "crmClientId" TEXT;

CREATE INDEX "ClientCall_crmClientId_idx" ON "ClientCall"("crmClientId");

ALTER TABLE "ClientCall"
  ADD CONSTRAINT "ClientCall_crmClientId_fkey"
  FOREIGN KEY ("crmClientId") REFERENCES "Client"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Pre-check: ensure every existing row has exactly one owner. The
-- CHECK constraint below will fail the migration if any row violates
-- the invariant, which is the desired behaviour.
ALTER TABLE "ClientCall"
  ADD CONSTRAINT "ClientCall_exactly_one_owner" CHECK (
    (CASE WHEN "leadId"          IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "crmClientId"     IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "clientRequestId" IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

-- Phase 5: Project.crmClientId (additive, nullable). Legacy clientId
-- untouched; new flow requires crmClientId at the DTO/service layer.

ALTER TABLE "Project" ADD COLUMN "crmClientId" TEXT;
CREATE INDEX "Project_crmClientId_idx" ON "Project"("crmClientId");
ALTER TABLE "Project"
  ADD CONSTRAINT "Project_crmClientId_fkey"
  FOREIGN KEY ("crmClientId") REFERENCES "Client"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
