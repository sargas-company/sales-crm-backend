-- Time Off — employee absences (VACATION / SICK_LEAVE / UNPAID_LEAVE).
--
-- Business rules enforced at the service layer:
--   • workingDays is computed server-side (Mon-Fri; weekends excluded)
--   • no overlapping records for the same employee
--   • VACATION/SICK_LEAVE cannot exceed the calendar-year allowance
--   • date-only semantics — pg DATE column, no timezone shift
--
-- Cascade:
--   • Deleting an Employee removes their time-off rows.
--   • createdBy remains a hard reference to User (record its author).

-- CreateEnum
CREATE TYPE "TimeOffType" AS ENUM ('VACATION', 'SICK_LEAVE', 'UNPAID_LEAVE');

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "TimeOffType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "workingDays" INTEGER NOT NULL,
    "note" TEXT,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "attachmentSize" INTEGER,
    "attachmentMime" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeOff_employeeId_startDate_idx" ON "TimeOff"("employeeId", "startDate");

-- CreateIndex
CREATE INDEX "TimeOff_type_idx" ON "TimeOff"("type");

-- CreateIndex
CREATE INDEX "TimeOff_startDate_idx" ON "TimeOff"("startDate");

-- CreateIndex
CREATE INDEX "TimeOff_endDate_idx" ON "TimeOff"("endDate");

-- AddForeignKey
ALTER TABLE "TimeOff"
  ADD CONSTRAINT "TimeOff_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeOff"
  ADD CONSTRAINT "TimeOff_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permission catalogue additions. Admin Manager preset (in seed.ts)
-- grants the four time_off:* keys plus employee_analytics:view. Owner
-- is auto-synced on next `make local-seed`.

INSERT INTO "Permission" (id, key, module, action, label, "createdAt") VALUES
  (gen_random_uuid(), 'time_off:view',            'time_off',            'view',   'View time-off records',            NOW()),
  (gen_random_uuid(), 'time_off:create',          'time_off',            'create', 'Create time-off records',          NOW()),
  (gen_random_uuid(), 'time_off:update',          'time_off',            'update', 'Update time-off records',          NOW()),
  (gen_random_uuid(), 'time_off:delete',          'time_off',            'delete', 'Delete time-off records',          NOW()),
  (gen_random_uuid(), 'employee_analytics:view',  'employee_analytics',  'view',   'View Employee Analytics dashboard', NOW())
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label;
