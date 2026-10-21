-- Random avatar URL per Employee. Column is nullable; the service
-- stamps a DiceBear-preset URL on create. Legacy rows stay NULL and
-- the UI falls back to coloured initials for them.
--
-- (Backfill UPDATE was intentionally dropped: it tripped the deploy
-- gateway's additive-only classifier. If the owner wants historical
-- rows populated, run scripts/backfill-employee-avatars.ts after the
-- migration lands.)
ALTER TABLE "Employee" ADD COLUMN "avatarUrl" TEXT;
