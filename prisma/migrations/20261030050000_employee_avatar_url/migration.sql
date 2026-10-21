-- Random avatar URL per Employee. Column is nullable; the service
-- stamps a DiceBear-preset URL on create. Backfill below gives every
-- existing row a deterministic DiceBear seed so the list avatars are
-- immediately populated after this migration lands — no "half the
-- directory has avatars, half doesn't" state.
ALTER TABLE "Employee" ADD COLUMN "avatarUrl" TEXT;

-- Backfill: deterministic DiceBear SVG keyed on the employee UUID.
-- Not from the preset catalogue (SQL can't easily list the 40 preset
-- objects), but the public URL style is identical — avataaars glyphs,
-- stable per row across refreshes.
UPDATE "Employee"
SET "avatarUrl" = 'https://api.dicebear.com/9.x/avataaars/svg?seed=' || "id"
WHERE "avatarUrl" IS NULL;
