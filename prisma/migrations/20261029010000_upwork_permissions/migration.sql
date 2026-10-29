-- Idempotent permission grants for the Upwork module.
-- Pattern mirrors 20261026010000_clients_permissions.

INSERT INTO "Permission" (id, key, module, action, label, "createdAt")
VALUES
  (gen_random_uuid(), 'upwork:view',             'upwork',           'view',   'View Upwork module',              NOW()),
  (gen_random_uuid(), 'upwork:create',           'upwork',           'create', 'Create Upwork entries',            NOW()),
  (gen_random_uuid(), 'upwork:update',           'upwork',           'update', 'Update Upwork entries',            NOW()),
  (gen_random_uuid(), 'upwork:delete',           'upwork',           'delete', 'Delete Upwork entries',            NOW()),
  (gen_random_uuid(), 'upwork_analytics:view',   'upwork_analytics', 'view',   'View Upwork analytics dashboard',  NOW())
ON CONFLICT (key) DO NOTHING;

-- Owner + Admin Manager — full access.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name IN ('owner', 'admin_manager')
  AND (p.key LIKE 'upwork:%' OR p.key = 'upwork_analytics:view')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Regular Manager — view + create + update, no delete, with analytics.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'regular_manager'
  AND p.key IN ('upwork:view', 'upwork:create', 'upwork:update', 'upwork_analytics:view')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
