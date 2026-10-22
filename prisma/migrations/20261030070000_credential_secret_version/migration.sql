-- Append-only history of CredentialAccount.encPayload values. One row
-- per edit or restore of a credential account; preserves the full
-- change history indefinitely so an owner can roll back a bad edit.
-- Additive migration — gateway auto-eligible.
CREATE TABLE "CredentialSecretVersion" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "changedById" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changeReason" TEXT NOT NULL,
  "encPayload" BYTEA NOT NULL,
  "encIv" BYTEA NOT NULL,
  "encAuthTag" BYTEA NOT NULL,
  "encKeyVersion" INTEGER NOT NULL DEFAULT 1,
  "encAlgorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
  CONSTRAINT "CredentialSecretVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CredentialSecretVersion_accountId_changedAt_idx"
  ON "CredentialSecretVersion" ("accountId", "changedAt" DESC);

ALTER TABLE "CredentialSecretVersion"
  ADD CONSTRAINT "CredentialSecretVersion_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CredentialAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
