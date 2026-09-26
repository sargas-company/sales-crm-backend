-- Roles & Permissions foundation.
-- See work/active/roles-and-permissions/{brief,specification}.md.
--
-- This migration:
--   1. Creates Role / Permission / RolePermission / AuditLog tables.
--   2. Loosens User.role to nullable and adds User.roleId (FK to Role).
--   3. Seeds the three system roles.
--   4. Seeds the permission catalogue (spec §1.2).
--   5. Binds RolePermission per the matrix (spec §1.3).
--   6. Backfills User.roleId from the legacy enum per approved map A
--      (ADMIN → owner, MANAGER → admin_manager).

-- ─── 1. Tables ────────────────────────────────────────────────────

CREATE TABLE "Role" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "description" TEXT,
    "system"      BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

CREATE TABLE "Permission" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "module"      TEXT NOT NULL,
    "action"      TEXT NOT NULL,
    "label"       TEXT,
    "description" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

CREATE TABLE "RolePermission" (
    "roleId"       TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

ALTER TABLE "RolePermission"
  ADD CONSTRAINT "RolePermission_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RolePermission"
  ADD CONSTRAINT "RolePermission_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AuditLog" (
    "id"         TEXT NOT NULL,
    "actorId"    TEXT,
    "action"     TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId"   TEXT NOT NULL,
    "summary"    JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. User: nullable role + new roleId FK ───────────────────────

ALTER TABLE "User" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ADD COLUMN "roleId" TEXT;

ALTER TABLE "User"
  ADD CONSTRAINT "User_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. System roles ──────────────────────────────────────────────

INSERT INTO "Role" ("id", "name", "label", "description", "system", "createdAt", "updatedAt") VALUES
  ('00000000-0000-0000-0000-000000000101', 'owner',           'Owner',           'Full access to every module, every field, including finance and salary data.', true, NOW(), NOW()),
  ('00000000-0000-0000-0000-000000000102', 'admin_manager',   'Admin Manager',   'Full operational access; no finance, salary or aggregate financial data.',    true, NOW(), NOW()),
  ('00000000-0000-0000-0000-000000000103', 'regular_manager', 'Regular Manager', 'Access only to explicitly granted modules and actions.',                     true, NOW(), NOW());

-- ─── 4. Permission catalogue (spec §1.2) ──────────────────────────

INSERT INTO "Permission" ("id", "key", "module", "action", "label", "createdAt") VALUES
  -- dashboards
  (gen_random_uuid(), 'dashboards_sales:view',   'dashboards_sales',   'view', 'View sales dashboard',   NOW()),
  (gen_random_uuid(), 'dashboards_finance:view', 'dashboards_finance', 'view', 'View finance dashboard', NOW()),
  -- proposals
  (gen_random_uuid(), 'proposals:view',   'proposals', 'view',   'View proposals',   NOW()),
  (gen_random_uuid(), 'proposals:create', 'proposals', 'create', 'Create proposals', NOW()),
  (gen_random_uuid(), 'proposals:update', 'proposals', 'update', 'Update proposals', NOW()),
  (gen_random_uuid(), 'proposals:delete', 'proposals', 'delete', 'Delete proposals', NOW()),
  -- platforms
  (gen_random_uuid(), 'platforms:view',   'platforms', 'view',   'View platforms',   NOW()),
  (gen_random_uuid(), 'platforms:create', 'platforms', 'create', 'Create platforms', NOW()),
  (gen_random_uuid(), 'platforms:update', 'platforms', 'update', 'Update platforms', NOW()),
  (gen_random_uuid(), 'platforms:delete', 'platforms', 'delete', 'Delete platforms', NOW()),
  -- job posts
  (gen_random_uuid(), 'job_posts:view',   'job_posts', 'view',   'View job posts',   NOW()),
  (gen_random_uuid(), 'job_posts:create', 'job_posts', 'create', 'Create job posts', NOW()),
  (gen_random_uuid(), 'job_posts:update', 'job_posts', 'update', 'Update job posts', NOW()),
  (gen_random_uuid(), 'job_posts:delete', 'job_posts', 'delete', 'Delete job posts', NOW()),
  -- accounts
  (gen_random_uuid(), 'accounts:view',   'accounts', 'view',   'View accounts',   NOW()),
  (gen_random_uuid(), 'accounts:create', 'accounts', 'create', 'Create accounts', NOW()),
  (gen_random_uuid(), 'accounts:update', 'accounts', 'update', 'Update accounts', NOW()),
  (gen_random_uuid(), 'accounts:delete', 'accounts', 'delete', 'Delete accounts', NOW()),
  -- leads
  (gen_random_uuid(), 'leads:view',   'leads', 'view',   'View leads',   NOW()),
  (gen_random_uuid(), 'leads:create', 'leads', 'create', 'Create leads', NOW()),
  (gen_random_uuid(), 'leads:update', 'leads', 'update', 'Update leads', NOW()),
  (gen_random_uuid(), 'leads:delete', 'leads', 'delete', 'Delete leads', NOW()),
  -- client calls
  (gen_random_uuid(), 'client_calls:view',   'client_calls', 'view',   'View client calls',   NOW()),
  (gen_random_uuid(), 'client_calls:create', 'client_calls', 'create', 'Create client calls', NOW()),
  (gen_random_uuid(), 'client_calls:update', 'client_calls', 'update', 'Update client calls', NOW()),
  (gen_random_uuid(), 'client_calls:delete', 'client_calls', 'delete', 'Delete client calls', NOW()),
  -- client requests
  (gen_random_uuid(), 'client_requests:view',   'client_requests', 'view',   'View client requests',   NOW()),
  (gen_random_uuid(), 'client_requests:create', 'client_requests', 'create', 'Create client requests', NOW()),
  (gen_random_uuid(), 'client_requests:update', 'client_requests', 'update', 'Update client requests', NOW()),
  (gen_random_uuid(), 'client_requests:delete', 'client_requests', 'delete', 'Delete client requests', NOW()),
  -- invoices
  (gen_random_uuid(), 'invoices:view',   'invoices', 'view',   'View invoices',   NOW()),
  (gen_random_uuid(), 'invoices:create', 'invoices', 'create', 'Create invoices', NOW()),
  (gen_random_uuid(), 'invoices:update', 'invoices', 'update', 'Update invoices', NOW()),
  (gen_random_uuid(), 'invoices:delete', 'invoices', 'delete', 'Delete invoices', NOW()),
  -- counterparties
  (gen_random_uuid(), 'counterparties:view',   'counterparties', 'view',   'View counterparties',   NOW()),
  (gen_random_uuid(), 'counterparties:create', 'counterparties', 'create', 'Create counterparties', NOW()),
  (gen_random_uuid(), 'counterparties:update', 'counterparties', 'update', 'Update counterparties', NOW()),
  (gen_random_uuid(), 'counterparties:delete', 'counterparties', 'delete', 'Delete counterparties', NOW()),
  -- prompts
  (gen_random_uuid(), 'prompts:view',   'prompts', 'view',   'View prompts',   NOW()),
  (gen_random_uuid(), 'prompts:create', 'prompts', 'create', 'Create prompts', NOW()),
  (gen_random_uuid(), 'prompts:update', 'prompts', 'update', 'Update prompts', NOW()),
  (gen_random_uuid(), 'prompts:delete', 'prompts', 'delete', 'Delete prompts', NOW()),
  -- employees
  (gen_random_uuid(), 'employees:view',   'employees', 'view',   'View employees',   NOW()),
  (gen_random_uuid(), 'employees:create', 'employees', 'create', 'Create employees', NOW()),
  (gen_random_uuid(), 'employees:update', 'employees', 'update', 'Update employees', NOW()),
  (gen_random_uuid(), 'employees:delete', 'employees', 'delete', 'Delete employees', NOW()),
  -- credentials (module CRUD + reveal/copy)
  (gen_random_uuid(), 'credentials:view',   'credentials', 'view',   'View credentials list',       NOW()),
  (gen_random_uuid(), 'credentials:create', 'credentials', 'create', 'Create credentials',          NOW()),
  (gen_random_uuid(), 'credentials:update', 'credentials', 'update', 'Update credentials',          NOW()),
  (gen_random_uuid(), 'credentials:delete', 'credentials', 'delete', 'Archive credentials',         NOW()),
  (gen_random_uuid(), 'credentials:reveal', 'credentials', 'reveal', 'Reveal credential secret',    NOW()),
  (gen_random_uuid(), 'credentials:copy',   'credentials', 'copy',   'Copy credential secret',      NOW()),
  -- salaries (Owner-only)
  (gen_random_uuid(), 'salaries:view',   'salaries', 'view',   'View salary records',   NOW()),
  (gen_random_uuid(), 'salaries:create', 'salaries', 'create', 'Create salary records', NOW()),
  (gen_random_uuid(), 'salaries:update', 'salaries', 'update', 'Update salary records', NOW()),
  (gen_random_uuid(), 'salaries:delete', 'salaries', 'delete', 'Delete salary records', NOW()),
  -- finances (Owner-only)
  (gen_random_uuid(), 'finances:view',   'finances', 'view',   'View finance records',   NOW()),
  (gen_random_uuid(), 'finances:create', 'finances', 'create', 'Create finance records', NOW()),
  (gen_random_uuid(), 'finances:update', 'finances', 'update', 'Update finance records', NOW()),
  (gen_random_uuid(), 'finances:delete', 'finances', 'delete', 'Delete finance records', NOW()),
  -- payment sources (Owner-only)
  (gen_random_uuid(), 'payment_sources:view',   'payment_sources', 'view',   'View payment sources',   NOW()),
  (gen_random_uuid(), 'payment_sources:create', 'payment_sources', 'create', 'Create payment sources', NOW()),
  (gen_random_uuid(), 'payment_sources:update', 'payment_sources', 'update', 'Update payment sources', NOW()),
  (gen_random_uuid(), 'payment_sources:delete', 'payment_sources', 'delete', 'Delete payment sources', NOW()),
  -- cashflow / profit (Owner-only, read-only aggregates)
  (gen_random_uuid(), 'cashflow:view', 'cashflow', 'view', 'View cashflow aggregate', NOW()),
  (gen_random_uuid(), 'profit:view',   'profit',   'view', 'View profit aggregate',   NOW()),
  -- compensation reviews
  (gen_random_uuid(), 'compensation_reviews:view',   'compensation_reviews', 'view',   'View compensation reviews',   NOW()),
  (gen_random_uuid(), 'compensation_reviews:create', 'compensation_reviews', 'create', 'Create compensation reviews', NOW()),
  (gen_random_uuid(), 'compensation_reviews:update', 'compensation_reviews', 'update', 'Update compensation reviews', NOW()),
  (gen_random_uuid(), 'compensation_reviews:delete', 'compensation_reviews', 'delete', 'Delete compensation reviews', NOW()),
  -- analytics (read-only aggregates)
  (gen_random_uuid(), 'sales_analytics:view',   'sales_analytics',   'view', 'View sales analytics',   NOW()),
  (gen_random_uuid(), 'finance_analytics:view', 'finance_analytics', 'view', 'View finance analytics', NOW()),
  -- roles admin (Owner-only)
  (gen_random_uuid(), 'roles:view',   'roles', 'view',   'View roles and permissions',   NOW()),
  (gen_random_uuid(), 'roles:create', 'roles', 'create', 'Create custom roles',           NOW()),
  (gen_random_uuid(), 'roles:update', 'roles', 'update', 'Update roles',                  NOW()),
  (gen_random_uuid(), 'roles:delete', 'roles', 'delete', 'Delete custom roles',           NOW()),
  (gen_random_uuid(), 'roles:assign', 'roles', 'assign', 'Assign a role to a user',       NOW()),
  -- settings
  (gen_random_uuid(), 'settings:view',   'settings', 'view',   'View application settings',   NOW()),
  (gen_random_uuid(), 'settings:update', 'settings', 'update', 'Update application settings', NOW());

-- ─── 5. RolePermission bindings (spec §1.3) ───────────────────────

-- Owner: every permission.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT '00000000-0000-0000-0000-000000000101', p.id FROM "Permission" p;

-- Admin Manager: full operational access minus finance / salary /
-- roles-admin; compensation_reviews view-only; settings view-only.
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT '00000000-0000-0000-0000-000000000102', p.id FROM "Permission" p
WHERE p.module IN (
  'dashboards_sales',
  'proposals', 'platforms', 'job_posts', 'accounts',
  'leads', 'client_calls', 'client_requests',
  'invoices', 'counterparties',
  'prompts', 'employees', 'credentials',
  'sales_analytics'
)
OR p.key IN ('compensation_reviews:view', 'settings:view');

-- Regular Manager: no permissions by default. Owner grants explicitly.

-- ─── 6. Backfill User.roleId per approved map A ───────────────────

UPDATE "User" SET "roleId" = '00000000-0000-0000-0000-000000000101' WHERE "role" = 'ADMIN';
UPDATE "User" SET "roleId" = '00000000-0000-0000-0000-000000000102' WHERE "role" = 'MANAGER';
