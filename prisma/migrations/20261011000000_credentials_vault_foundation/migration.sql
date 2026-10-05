-- Credentials vault · Phase 1 · Foundation.
--
-- Adds the encrypted-at-rest credential vault (CredentialProfile,
-- CredentialAccount, CredentialAttachment), the MFA foundation
-- (UserMfaCredential, VaultSession) that Phase 3 will hydrate, and the
-- application-wide AuditEvent stream. Additive only — no writes to
-- existing tables besides adding one nullable relation.
--
-- Secrets are stored as Bytes columns (encPayload/encIv/encAuthTag +
-- key version + algorithm string). The DB never sees plaintext.

-- ─── Enums ─────────────────────────────────────────────────────────────
CREATE TYPE "CredentialProfileType"   AS ENUM ('PERSON', 'COMPANY', 'OTHER');
CREATE TYPE "CredentialProfileStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "CredentialAccountStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "MfaFactorType"           AS ENUM ('WEBAUTHN', 'TOTP', 'RECOVERY');
CREATE TYPE "AuditResult"             AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- ─── CredentialProfile ─────────────────────────────────────────────────
CREATE TABLE "CredentialProfile" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "type"        "CredentialProfileType" NOT NULL,
    "status"      "CredentialProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeId"  TEXT,
    "avatarUrl"   TEXT,
    "description" TEXT,
    "tags"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CredentialProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CredentialProfile_slug_key"       ON "CredentialProfile"("slug");
CREATE INDEX        "CredentialProfile_status_idx"     ON "CredentialProfile"("status");
CREATE INDEX        "CredentialProfile_type_idx"       ON "CredentialProfile"("type");
CREATE INDEX        "CredentialProfile_employeeId_idx" ON "CredentialProfile"("employeeId");
ALTER TABLE "CredentialProfile"
  ADD CONSTRAINT "CredentialProfile_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── CredentialAccount ─────────────────────────────────────────────────
CREATE TABLE "CredentialAccount" (
    "id"                 TEXT NOT NULL,
    "profileId"          TEXT NOT NULL,
    "serviceName"        TEXT NOT NULL,
    "category"           TEXT NOT NULL,
    "serviceUrl"         TEXT,
    "iconUrl"            TEXT,
    "tags"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "usernameHint"       TEXT,
    "status"             "CredentialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "encPayload"         BYTEA NOT NULL,
    "encIv"              BYTEA NOT NULL,
    "encAuthTag"         BYTEA NOT NULL,
    "encKeyVersion"      INTEGER NOT NULL DEFAULT 1,
    "encAlgorithm"       TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "lastRotatedAt"      TIMESTAMP(3),
    "rotationReminderAt" TIMESTAMP(3),
    "createdById"        TEXT,
    "updatedById"        TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CredentialAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CredentialAccount_profileId_status_idx" ON "CredentialAccount"("profileId", "status");
CREATE INDEX "CredentialAccount_category_idx"         ON "CredentialAccount"("category");
CREATE INDEX "CredentialAccount_serviceName_idx"      ON "CredentialAccount"("serviceName");
ALTER TABLE "CredentialAccount"
  ADD CONSTRAINT "CredentialAccount_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "CredentialProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CredentialAttachment ──────────────────────────────────────────────
CREATE TABLE "CredentialAttachment" (
    "id"                TEXT NOT NULL,
    "accountId"         TEXT NOT NULL,
    "encMeta"           BYTEA NOT NULL,
    "encMetaIv"         BYTEA NOT NULL,
    "encMetaAuthTag"    BYTEA NOT NULL,
    "encContent"        BYTEA NOT NULL,
    "encContentIv"      BYTEA NOT NULL,
    "encContentAuthTag" BYTEA NOT NULL,
    "encStorageRef"     BYTEA,
    "encKeyVersion"     INTEGER NOT NULL DEFAULT 1,
    "encAlgorithm"      TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "size"              INTEGER NOT NULL,
    "uploadedById"      TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CredentialAttachment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CredentialAttachment_accountId_idx" ON "CredentialAttachment"("accountId");
ALTER TABLE "CredentialAttachment"
  ADD CONSTRAINT "CredentialAttachment_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CredentialAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── UserMfaCredential ─────────────────────────────────────────────────
CREATE TABLE "UserMfaCredential" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "type"           "MfaFactorType" NOT NULL,
    "credentialId"   BYTEA,
    "publicKey"      BYTEA,
    "counter"        BIGINT,
    "transports"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deviceLabel"    TEXT,
    "encTotpSeed"    BYTEA,
    "totpIv"         BYTEA,
    "totpAuthTag"    BYTEA,
    "totpKeyVersion" INTEGER,
    "totpAlgorithm"  TEXT,
    "codeHash"       TEXT,
    "codeIndex"      INTEGER,
    "usedAt"         TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt"     TIMESTAMP(3),
    CONSTRAINT "UserMfaCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserMfaCredential_credentialId_key" ON "UserMfaCredential"("credentialId");
CREATE INDEX        "UserMfaCredential_userId_type_idx"  ON "UserMfaCredential"("userId", "type");

-- ─── VaultSession ──────────────────────────────────────────────────────
CREATE TABLE "VaultSession" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "authSessionId" TEXT,
    "tokenHash"     TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"     TIMESTAMP(3) NOT NULL,
    "revokedAt"     TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastUsedAt"    TIMESTAMP(3),
    "ip"            TEXT,
    "userAgent"     TEXT,
    CONSTRAINT "VaultSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VaultSession_tokenHash_key"      ON "VaultSession"("tokenHash");
CREATE INDEX        "VaultSession_userId_expiresAt_idx" ON "VaultSession"("userId", "expiresAt");

-- ─── AuditEvent ────────────────────────────────────────────────────────
CREATE TABLE "AuditEvent" (
    "id"          TEXT NOT NULL,
    "actorUserId" TEXT,
    "domain"      TEXT NOT NULL,
    "action"      TEXT NOT NULL,
    "targetType"  TEXT,
    "targetId"    TEXT,
    "targetLabel" TEXT,
    "result"      "AuditResult" NOT NULL,
    "metadata"    JSONB,
    "ip"          TEXT,
    "userAgent"   TEXT,
    "requestId"   TEXT,
    "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_domain_occurredAt_idx"                ON "AuditEvent"("domain", "occurredAt");
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx"           ON "AuditEvent"("actorUserId", "occurredAt");
CREATE INDEX "AuditEvent_targetType_targetId_occurredAt_idx"   ON "AuditEvent"("targetType", "targetId", "occurredAt");
