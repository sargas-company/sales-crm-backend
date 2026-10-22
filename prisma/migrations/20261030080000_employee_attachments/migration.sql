-- EmployeeAttachment: files attached to an Employee record (passport
-- scans, contracts, screenshots etc). Stored in the Backblaze
-- EMPLOYEE_ATTACHMENTS bucket; this table holds only the key +
-- metadata. HR/Owner upload/delete via EDIT screen; download served
-- through short-lived signed URLs. CASCADE on Employee delete — the
-- service layer also removes the matching B2 objects.
--
-- Additive migration (new table, new permission catalog rows). Safe
-- for the gateway auto-apply path.

CREATE TABLE "EmployeeAttachment" (
    "id"           TEXT NOT NULL,
    "employeeId"   TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey"   TEXT NOT NULL,
    "mimeType"     TEXT NOT NULL,
    "size"         INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmployeeAttachment_storageKey_key"
    ON "EmployeeAttachment"("storageKey");

CREATE INDEX "EmployeeAttachment_employeeId_createdAt_idx"
    ON "EmployeeAttachment"("employeeId", "createdAt" DESC);

ALTER TABLE "EmployeeAttachment" ADD CONSTRAINT "EmployeeAttachment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeAttachment" ADD CONSTRAINT "EmployeeAttachment_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Permission catalog: three new keys for granular control. HR / Owner
-- holds all three; roles with employees:view also get :view.
INSERT INTO "Permission" ("id", "key", "module", "action", "label", "description", "createdAt")
VALUES
  (gen_random_uuid(), 'employees:attachments:view',   'employees', 'attachments:view',   'View employee attachments',   'List and download files attached to employee records.',       CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'employees:attachments:create', 'employees', 'attachments:create', 'Upload employee attachments', 'Attach new files to an employee record.',                     CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'employees:attachments:delete', 'employees', 'attachments:delete', 'Delete employee attachments', 'Remove attached files from an employee record (B2 purged).',  CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
