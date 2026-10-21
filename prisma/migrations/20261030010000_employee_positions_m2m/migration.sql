-- Convert Employee.positions from a String[] scalar to an implicit
-- many-to-many relation with Position. All existing string labels
-- are dropped — the owner opted into a clean rebuild through the
-- new Position catalogue UI.
--
-- Shape mirrors what `prisma migrate dev` would emit for an
-- implicit M2M between Employee and Position: a junction table
-- named `_EmployeeToPosition` with columns A (Employee.id) and
-- B (Position.id), both FK CASCADE on delete and update.

-- 1. Junction table + Prisma's canonical indexes.
CREATE TABLE "_EmployeeToPosition" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_EmployeeToPosition_A_fkey" FOREIGN KEY ("A")
    REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "_EmployeeToPosition_B_fkey" FOREIGN KEY ("B")
    REFERENCES "Position"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "_EmployeeToPosition_AB_unique"
  ON "_EmployeeToPosition"("A", "B");

CREATE INDEX "_EmployeeToPosition_B_index"
  ON "_EmployeeToPosition"("B");

-- 2. Drop the legacy scalar column. This destroys every pre-existing
--    role label — intentional, no backfill. Rebuild via the Position
--    catalogue + Employee form.
ALTER TABLE "Employee" DROP COLUMN "positions";
