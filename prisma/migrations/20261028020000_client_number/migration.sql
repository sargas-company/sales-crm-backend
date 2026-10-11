-- Public-facing sequential number for Client — mirror of Lead.number.
-- Backfills existing rows by createdAt so the UI "#" column shows
-- numbers in the order rows were created.

-- 1. Add column nullable so backfill can populate it.
ALTER TABLE "Client" ADD COLUMN "number" INTEGER;

-- 2. Create the sequence and backfill in createdAt order.
CREATE SEQUENCE "Client_number_seq" AS INTEGER START 1 OWNED BY "Client"."number";

WITH ordered AS (
	SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt") AS rn
	FROM "Client"
)
UPDATE "Client" c
SET "number" = ordered.rn
FROM ordered
WHERE c.id = ordered.id;

-- 3. Advance the sequence past the backfilled max so the next INSERT
--    doesn't collide with an existing value.
SELECT setval(
	'"Client_number_seq"',
	COALESCE((SELECT MAX("number") FROM "Client"), 0) + 1,
	false
);

-- 4. Enforce NOT NULL + UNIQUE + wire the default to the sequence.
ALTER TABLE "Client" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "Client" ALTER COLUMN "number" SET DEFAULT nextval('"Client_number_seq"');
CREATE UNIQUE INDEX "Client_number_key" ON "Client"("number");
