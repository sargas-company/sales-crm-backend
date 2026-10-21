-- Position entity: managed catalogue of employee role titles.
-- Employee.positions stays a free String[] and is matched by title in
-- the UI; this migration adds the catalogue table + four permissions +
-- the Owner / Admin Manager role bindings so the module is usable the
-- moment `prisma migrate deploy` + `make prod-seed-system` run.

-- 1. Position table.
CREATE TABLE "Position" (
  "id"        TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Position_title_key" ON "Position"("title");
CREATE UNIQUE INDEX "Position_slug_key"  ON "Position"("slug");

-- 2. Register the four Permission rows (idempotent on re-run).
INSERT INTO "Permission" (id, key, module, action, label, "createdAt")
VALUES
  (gen_random_uuid(), 'positions:view',   'positions', 'view',   'View positions',   NOW()),
  (gen_random_uuid(), 'positions:create', 'positions', 'create', 'Create positions', NOW()),
  (gen_random_uuid(), 'positions:update', 'positions', 'update', 'Update positions', NOW()),
  (gen_random_uuid(), 'positions:delete', 'positions', 'delete', 'Delete positions', NOW())
ON CONFLICT (key) DO NOTHING;

-- 3. Owner + Admin Manager — full CRUD. Mirrors the Platforms binding
--    tier (Position is a catalogue sibling of Platform).
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name IN ('owner', 'admin_manager')
  AND p.key LIKE 'positions:%'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
