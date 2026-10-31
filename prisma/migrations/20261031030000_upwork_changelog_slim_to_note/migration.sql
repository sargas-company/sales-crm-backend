-- Slim UpworkChangeLog to the bare minimum. Owner dropped the
-- narrative / before-after block entirely in favour of a single
-- free-text `note`. Existing rows are wiped (seed re-fills).

DELETE FROM "UpworkChangeLog";

ALTER TABLE "UpworkChangeLog"
  DROP COLUMN "item",
  DROP COLUMN "summary",
  DROP COLUMN "reason",
  DROP COLUMN "before",
  DROP COLUMN "after",
  ADD COLUMN "note" TEXT NOT NULL;
