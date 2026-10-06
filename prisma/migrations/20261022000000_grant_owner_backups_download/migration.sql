-- Create the `backups:download` permission (if not yet in catalog)
-- and grant it to the Owner role only.
--
-- The permission key is also added to prisma/seed.ts so fresh
-- installs land it via `prisma db seed`. This migration is the
-- idempotent path for environments that run only `migrate deploy`
-- and would otherwise be missing both the Permission row and the
-- Owner RolePermission binding.
--
-- Idempotent on both inserts:
--   • Permission is keyed by `key` (@unique) → ON CONFLICT (key) DO NOTHING.
--   • RolePermission has composite PK (roleId, permissionId) → ON CONFLICT DO NOTHING.
--
-- Admin Manager and Regular Manager are intentionally NOT granted —
-- they are listed in ADMIN_FORBIDDEN / REGULAR_FORBIDDEN in
-- system-role-matrix.spec.ts, which enforces the Owner-only policy
-- for every backups:* permission.
INSERT INTO "Permission" ("id", "key", "module", "action", "label")
VALUES (
  gen_random_uuid(),
  'backups:download',
  'backups',
  'download',
  'Download database backup artifact'
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
  FROM "Role" r
  CROSS JOIN "Permission" p
 WHERE r.name = 'owner'
   AND p.key = 'backups:download'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
