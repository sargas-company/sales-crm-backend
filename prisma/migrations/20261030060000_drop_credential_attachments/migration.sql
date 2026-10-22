-- Drop Credentials-attachments feature.
--
-- Table + relation to CredentialAccount are gone; prod has no rows
-- (owner-confirmed before merge). The matching permission catalog
-- entry is cleaned up with a tolerant DELETE so re-apply on an
-- empty seed is a no-op.
--
-- Gateway: this is destructive (DROP TABLE) and goes through the
-- manual operator path (make backup / make backup-verify /
-- make prod-migrate on the prod host).
DROP TABLE IF EXISTS "CredentialAttachment";

-- Permission + RolePermission cleanup. The `credentials:attachments`
-- row disappears together with any RolePermission binding to it
-- (CASCADE via the FK in the Permission model).
DELETE FROM "Permission" WHERE "key" = 'credentials:attachments';
