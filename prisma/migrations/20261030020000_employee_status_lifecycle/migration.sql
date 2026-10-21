-- Employee lifecycle refactor:
--   active   -> ACTIVE       (semantic rename, uppercase canonical)
--   inactive -> TERMINATED   (semantic rename — the old inactive label
--                             was always used for leavers)
--   +BENCH                   (new tier for hired-but-idle)
--
-- Also add `terminatedAt` so "archive" views can be derived from age
-- rather than needing a dedicated ARCHIVED status.
--
-- NOTE: `ALTER TYPE ... RENAME VALUE` and `ALTER TYPE ... ADD VALUE`
-- cannot be mixed with other statements inside the same transaction
-- on older Postgres builds. Prisma migrate runs each statement on its
-- own, so the file layout below is already safe. If this ever fails
-- on a very old PG, split the ALTER TYPE lines into their own
-- migration folder.

ALTER TYPE "EmployeeStatus" RENAME VALUE 'active'   TO 'ACTIVE';
ALTER TYPE "EmployeeStatus" RENAME VALUE 'inactive' TO 'TERMINATED';
ALTER TYPE "EmployeeStatus" ADD VALUE 'BENCH' AFTER 'ACTIVE';

-- Default on the column still references the enum literal; Prisma's
-- generated client has already been regenerated to the new names.
-- No DEFAULT rewrite needed — Postgres resolves the enum by OID.

ALTER TABLE "Employee" ADD COLUMN "terminatedAt" TIMESTAMP(3);
