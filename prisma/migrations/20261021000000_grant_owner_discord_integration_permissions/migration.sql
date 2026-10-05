-- Grant the Owner role the four discord_integration:* permissions.
--
-- Migration 20261018000000_discord_integration inserted these keys
-- into the Permission catalog but never linked them to the Owner
-- role in RolePermission. `prisma/seed.ts` does rebuild Owner's
-- RolePermission set from the catalog, but seeds only run on
-- `prisma db seed` — an environment that only ran `migrate deploy`
-- stays short by exactly these 4 grants, which is why GET
-- /discord-integration/profiles returned 403 for a signed-in Owner.
--
-- Idempotent via (roleId, permissionId) PK upsert. Admin Manager and
-- Regular Manager are intentionally NOT granted — they are listed in
-- ADMIN_FORBIDDEN / REGULAR_FORBIDDEN (system-role-matrix.spec.ts).
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
  FROM "Role" r
  CROSS JOIN "Permission" p
 WHERE r.name = 'owner'
   AND p.key IN (
     'discord_integration:view',
     'discord_integration:configure',
     'discord_integration:send_test',
     'discord_integration:activate_profile'
   )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
