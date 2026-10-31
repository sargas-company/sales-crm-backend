-- Upwork is owner-only. Revoke all upwork:* and upwork_analytics:view
-- grants from admin_manager and regular_manager system roles. Owner
-- keeps everything via the Owner-is-superset invariant in seed-system.

DELETE FROM "RolePermission"
WHERE "roleId" IN (
  SELECT id FROM "Role" WHERE name IN ('admin_manager', 'regular_manager')
)
AND "permissionId" IN (
  SELECT id FROM "Permission"
  WHERE key LIKE 'upwork:%' OR key = 'upwork_analytics:view'
);
