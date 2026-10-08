-- Idempotent production permission grants for the new CRM Client
-- module. Follows the exact pattern used by earlier role-permission
-- migrations (see 20260927120000_add_roles_and_permissions). Safe to
-- re-run and does not touch unrelated roles / permissions.

-- 1. Register the four Permission rows (no-op on re-run thanks to the
--    unique key constraint on Permission.key).
INSERT INTO "Permission" (id, key, module, action, label, "createdAt")
VALUES
  (gen_random_uuid(), 'clients:view',   'clients', 'view',   'View CRM clients',   NOW()),
  (gen_random_uuid(), 'clients:create', 'clients', 'create', 'Create CRM clients', NOW()),
  (gen_random_uuid(), 'clients:update', 'clients', 'update', 'Update CRM clients', NOW()),
  (gen_random_uuid(), 'clients:delete', 'clients', 'delete', 'Delete CRM clients', NOW())
ON CONFLICT (key) DO NOTHING;

-- 2. Owner + Admin Manager — full CRUD. We identify these two roles by
--    their canonical system-role names ('owner', 'admin_manager'), the
--    same keys system-role-presets.ts exports. We never widen other
--    roles.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name IN ('owner', 'admin_manager')
  AND p.key LIKE 'clients:%'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 3. Regular Manager — view + create + update (NO delete). This lets a
--    manager with projects:create populate the Project Client dropdown
--    without needing counterparties:view, while delete stays Owner /
--    Admin.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'regular_manager'
  AND p.key IN ('clients:view', 'clients:create', 'clients:update')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
