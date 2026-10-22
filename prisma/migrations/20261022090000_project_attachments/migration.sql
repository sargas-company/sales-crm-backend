-- ProjectAttachment: files attached to a Project record (briefs,
-- assets, contracts etc.). Stored in the Backblaze
-- PROJECT_ATTACHMENTS bucket; this table holds only the key +
-- metadata. Upload/delete via the Project EDIT screen; download served
-- through short-lived signed URLs. CASCADE on Project delete — the
-- service layer also removes the matching B2 objects.
--
-- Additive migration (new table, new permission catalog rows). Safe
-- for the gateway auto-apply path.

CREATE TABLE "ProjectAttachment" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey"   TEXT NOT NULL,
    "mimeType"     TEXT NOT NULL,
    "size"         INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectAttachment_storageKey_key"
    ON "ProjectAttachment"("storageKey");

CREATE INDEX "ProjectAttachment_projectId_createdAt_idx"
    ON "ProjectAttachment"("projectId", "createdAt" DESC);

ALTER TABLE "ProjectAttachment" ADD CONSTRAINT "ProjectAttachment_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectAttachment" ADD CONSTRAINT "ProjectAttachment_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Permission catalog: three new keys mirroring the employee shape.
-- Admin Manager / Owner hold all three; downstream role bootstrap
-- grants :view wherever `projects:view` is granted.
INSERT INTO "Permission" ("id", "key", "module", "action", "label", "description", "createdAt")
VALUES
  (gen_random_uuid(), 'projects:attachments:view',   'projects', 'attachments:view',   'View project attachments',   'List and download files attached to project records.',       CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'projects:attachments:create', 'projects', 'attachments:create', 'Upload project attachments', 'Attach new files to a project record.',                     CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'projects:attachments:delete', 'projects', 'attachments:delete', 'Delete project attachments', 'Remove attached files from a project record (B2 purged).',  CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
