-- PhoneNumber.boardSlot — position on the physical SIM-card board.
-- NULL means "not placed yet" (shown in the Unassigned list on the
-- /phone-numbers/board page). PostgreSQL treats NULLs as distinct in
-- unique indexes, so a plain UNIQUE enforces one-card-per-slot while
-- still allowing many NULL rows.

ALTER TABLE "PhoneNumber" ADD COLUMN "boardSlot" INTEGER;

CREATE UNIQUE INDEX "PhoneNumber_boardSlot_key" ON "PhoneNumber"("boardSlot");
