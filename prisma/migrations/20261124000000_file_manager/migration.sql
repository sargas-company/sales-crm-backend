-- File Manager — standalone corporate file space. No FK to any
-- business entity: owner's explicit rule is that this section does
-- not know about Project/Client/Employee. Additive-only migration.

CREATE TABLE "FileManagerFolder" (
    "id"           TEXT        NOT NULL,
    "name"         TEXT        NOT NULL,
    "parentId"     TEXT,
    "createdById"  TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileManagerFolder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FileManagerFolder_parentId_name_key" ON "FileManagerFolder"("parentId", "name");
CREATE INDEX "FileManagerFolder_parentId_idx" ON "FileManagerFolder"("parentId");
CREATE INDEX "FileManagerFolder_createdAt_idx" ON "FileManagerFolder"("createdAt");

ALTER TABLE "FileManagerFolder"
  ADD CONSTRAINT "FileManagerFolder_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "FileManagerFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FileManagerFolder"
  ADD CONSTRAINT "FileManagerFolder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "FileManagerFile" (
    "id"           TEXT        NOT NULL,
    "folderId"     TEXT,
    "originalName" TEXT        NOT NULL,
    "storageKey"   TEXT        NOT NULL,
    "mimeType"     TEXT        NOT NULL,
    "size"         INTEGER     NOT NULL,
    "uploadedById" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileManagerFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FileManagerFile_storageKey_key" ON "FileManagerFile"("storageKey");
CREATE INDEX "FileManagerFile_folderId_idx" ON "FileManagerFile"("folderId");
CREATE INDEX "FileManagerFile_createdAt_idx" ON "FileManagerFile"("createdAt");

ALTER TABLE "FileManagerFile"
  ADD CONSTRAINT "FileManagerFile_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "FileManagerFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FileManagerFile"
  ADD CONSTRAINT "FileManagerFile_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Permissions: standalone corporate file space, visible only to the
-- three business roles (owner / admin_manager / regular_manager) per
-- owner's rule. Idempotent via ON CONFLICT.

INSERT INTO "Permission" ("id", "key", "module", "action", "label", "description", "createdAt")
VALUES
  (gen_random_uuid(), 'file_manager:view',   'file_manager', 'view',   'View File Manager',   'See folders and files in the corporate file space.',   now()),
  (gen_random_uuid(), 'file_manager:manage', 'file_manager', 'manage', 'Manage File Manager', 'Create / rename / move / delete folders and upload or delete files.', now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
  FROM "Role" r
  CROSS JOIN "Permission" p
 WHERE r.name IN ('owner', 'admin_manager', 'regular_manager')
   AND p.key IN ('file_manager:view', 'file_manager:manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
