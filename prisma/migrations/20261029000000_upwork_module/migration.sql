-- Upwork module: 6 tables + 2 enums. All data is entered manually
-- (no Upwork API/scraping). profileId on ReferenceData is nullable:
-- NULL means the entry is shared across all profiles.

CREATE TYPE "UpworkReferenceCategory" AS ENUM (
  'title_phrase',
  'suggestion',
  'related_query',
  'green_skill',
  'job_skill',
  'client_phrase',
  'requirement',
  'product_type',
  'hire_list_skill',
  'fact'
);

CREATE TYPE "UpworkChangeLogSection" AS ENUM (
  'title',
  'overview',
  'skills',
  'portfolio',
  'project_catalog',
  'consultation',
  'certificate',
  'employment_history',
  'other_experience',
  'contract',
  'video',
  'other'
);

-- Profiles
CREATE TABLE "UpworkProfile" (
  "id"        TEXT        PRIMARY KEY,
  "name"      TEXT        NOT NULL,
  "url"       TEXT,
  "note"      TEXT,
  "active"    BOOLEAN     NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "UpworkProfile_active_idx" ON "UpworkProfile"("active");

-- Reference data
CREATE TABLE "UpworkReferenceData" (
  "id"            TEXT                       PRIMARY KEY,
  "profileId"     TEXT,
  "category"      "UpworkReferenceCategory"  NOT NULL,
  "value"         TEXT                       NOT NULL,
  "parentId"      TEXT,
  "order"         INTEGER,
  "frequency"     INTEGER,
  "note"          TEXT,
  "collectedDate" TIMESTAMP(3)               NOT NULL,
  "active"        BOOLEAN                    NOT NULL DEFAULT TRUE,
  "createdAt"     TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)               NOT NULL,
  CONSTRAINT "UpworkReferenceData_profile_fkey"
    FOREIGN KEY ("profileId") REFERENCES "UpworkProfile"("id") ON DELETE SET NULL,
  CONSTRAINT "UpworkReferenceData_parent_fkey"
    FOREIGN KEY ("parentId") REFERENCES "UpworkReferenceData"("id") ON DELETE SET NULL
);
CREATE INDEX "UpworkReferenceData_profileId_category_idx"
  ON "UpworkReferenceData"("profileId", "category");
CREATE INDEX "UpworkReferenceData_category_active_idx"
  ON "UpworkReferenceData"("category", "active");
CREATE INDEX "UpworkReferenceData_parentId_idx"
  ON "UpworkReferenceData"("parentId");

-- Change log
CREATE TABLE "UpworkChangeLog" (
  "id"        TEXT                     PRIMARY KEY,
  "date"      TIMESTAMP(3)             NOT NULL,
  "profileId" TEXT                     NOT NULL,
  "section"   "UpworkChangeLogSection" NOT NULL,
  "item"      TEXT,
  "summary"   TEXT                     NOT NULL,
  "reason"    TEXT,
  "before"    TEXT                     NOT NULL,
  "after"     TEXT                     NOT NULL,
  "createdAt" TIMESTAMP(3)             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3)             NOT NULL,
  CONSTRAINT "UpworkChangeLog_profile_fkey"
    FOREIGN KEY ("profileId") REFERENCES "UpworkProfile"("id") ON DELETE CASCADE
);
CREATE INDEX "UpworkChangeLog_profileId_date_idx"
  ON "UpworkChangeLog"("profileId", "date");
CREATE INDEX "UpworkChangeLog_profileId_section_idx"
  ON "UpworkChangeLog"("profileId", "section");
CREATE INDEX "UpworkChangeLog_date_idx" ON "UpworkChangeLog"("date");

-- Change log ↔ reference data (which entries drove the edit)
CREATE TABLE "UpworkChangeLogReference" (
  "changeLogId"     TEXT         NOT NULL,
  "referenceDataId" TEXT         NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("changeLogId", "referenceDataId"),
  CONSTRAINT "UpworkChangeLogReference_log_fkey"
    FOREIGN KEY ("changeLogId") REFERENCES "UpworkChangeLog"("id") ON DELETE CASCADE,
  CONSTRAINT "UpworkChangeLogReference_ref_fkey"
    FOREIGN KEY ("referenceDataId") REFERENCES "UpworkReferenceData"("id") ON DELETE RESTRICT
);
CREATE INDEX "UpworkChangeLogReference_referenceDataId_idx"
  ON "UpworkChangeLogReference"("referenceDataId");

-- Metrics snapshots
CREATE TABLE "UpworkMetricsSnapshot" (
  "id"             TEXT         PRIMARY KEY,
  "date"           TIMESTAMP(3) NOT NULL,
  "profileId"      TEXT         NOT NULL,
  "views"          INTEGER      NOT NULL DEFAULT 0,
  "invites"        INTEGER      NOT NULL DEFAULT 0,
  "directMessages" INTEGER      NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UpworkMetricsSnapshot_profile_fkey"
    FOREIGN KEY ("profileId") REFERENCES "UpworkProfile"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "UpworkMetricsSnapshot_profileId_date_key"
  ON "UpworkMetricsSnapshot"("profileId", "date");
CREATE INDEX "UpworkMetricsSnapshot_profileId_date_idx"
  ON "UpworkMetricsSnapshot"("profileId", "date");

-- Per-title-phrase positions inside a snapshot
CREATE TABLE "UpworkMetricsSnapshotPosition" (
  "id"              TEXT    PRIMARY KEY,
  "snapshotId"      TEXT    NOT NULL,
  "referenceDataId" TEXT    NOT NULL,
  "position"        INTEGER NOT NULL,
  CONSTRAINT "UpworkMetricsSnapshotPosition_snapshot_fkey"
    FOREIGN KEY ("snapshotId") REFERENCES "UpworkMetricsSnapshot"("id") ON DELETE CASCADE,
  CONSTRAINT "UpworkMetricsSnapshotPosition_ref_fkey"
    FOREIGN KEY ("referenceDataId") REFERENCES "UpworkReferenceData"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "UpworkMetricsSnapshotPosition_snapshotId_referenceDataId_key"
  ON "UpworkMetricsSnapshotPosition"("snapshotId", "referenceDataId");
CREATE INDEX "UpworkMetricsSnapshotPosition_referenceDataId_idx"
  ON "UpworkMetricsSnapshotPosition"("referenceDataId");
