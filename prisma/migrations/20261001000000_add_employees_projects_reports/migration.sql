-- Employees, Projects and Project Reports (spec: Employees / Projects MVP).
--
-- New enums:
--   EmployeeStatus  = active | inactive
--   ProjectStatus   = planned | active | paused | completed | archived
--
-- New tables:
--   Employee         — team member directory; optional 1:1 link to User.
--   Project          — client engagement; optional link to Counterparty.
--   ProjectMember    — join Project <-> Employee (assignedAt).
--   ProjectReport    — one row per (project, employee, day).
--
-- Deletes:
--   Employee.user link is SetNull (deleting the auth user leaves the
--     employee record intact).
--   Project.client is SetNull (deleting the counterparty leaves the
--     project record intact).
--   ProjectMember and ProjectReport cascade with their Project/Employee
--     parents.

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('planned', 'active', 'paused', 'completed', 'archived');

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "positions" TEXT[],
    "status" "EmployeeStatus" NOT NULL DEFAULT 'active',
    "hiredAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_email_key" ON "Employee"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_status_idx" ON "Employee"("status");

-- AddForeignKey
ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'planned',
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "Project"("clientId");

-- AddForeignKey
ALTER TABLE "Project"
  ADD CONSTRAINT "Project_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId", "employeeId")
);

-- CreateIndex
CREATE INDEX "ProjectMember_employeeId_idx" ON "ProjectMember"("employeeId");

-- AddForeignKey
ALTER TABLE "ProjectMember"
  ADD CONSTRAINT "ProjectMember_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember"
  ADD CONSTRAINT "ProjectMember_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ProjectReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectReport_projectId_employeeId_reportDate_key"
  ON "ProjectReport"("projectId", "employeeId", "reportDate");

-- CreateIndex
CREATE INDEX "ProjectReport_projectId_idx" ON "ProjectReport"("projectId");

-- CreateIndex
CREATE INDEX "ProjectReport_employeeId_idx" ON "ProjectReport"("employeeId");

-- CreateIndex
CREATE INDEX "ProjectReport_reportDate_idx" ON "ProjectReport"("reportDate");

-- AddForeignKey
ALTER TABLE "ProjectReport"
  ADD CONSTRAINT "ProjectReport_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectReport"
  ADD CONSTRAINT "ProjectReport_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permission catalogue additions for the new modules.
-- Owner is auto-synced from the seed script, so all three keys land there
-- as soon as the operator runs `make local-seed` (or after any
-- `make local-reset`). Admin Manager preset (also in seed.ts) grants
-- projects:*, project_reports:* and employees:view. Regular Manager
-- stays empty by default; a scope elevator (`projects:view_any`) is
-- introduced so callers without it are automatically scoped to their
-- own projects / reports.

INSERT INTO "Permission" (id, key, module, action, label, "createdAt") VALUES
  (gen_random_uuid(), 'projects:view',          'projects',        'view',   'View projects',          NOW()),
  (gen_random_uuid(), 'projects:create',        'projects',        'create', 'Create projects',        NOW()),
  (gen_random_uuid(), 'projects:update',        'projects',        'update', 'Update projects',        NOW()),
  (gen_random_uuid(), 'projects:delete',        'projects',        'delete', 'Delete projects',        NOW()),
  (gen_random_uuid(), 'projects:view_any',      'projects',        'view_any', 'View every project and report, not just your own', NOW()),
  (gen_random_uuid(), 'project_reports:view',   'project_reports', 'view',   'View project reports',   NOW()),
  (gen_random_uuid(), 'project_reports:create', 'project_reports', 'create', 'Create project reports', NOW()),
  (gen_random_uuid(), 'project_reports:update', 'project_reports', 'update', 'Update project reports', NOW()),
  (gen_random_uuid(), 'project_reports:delete', 'project_reports', 'delete', 'Delete project reports', NOW())
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label;
