-- Fill existing nulls before adding NOT NULL constraint
UPDATE "User" SET "firstName" = 'Unknown' WHERE "firstName" IS NULL;
UPDATE "User" SET "lastName" = 'Unknown' WHERE "lastName" IS NULL;

-- AlterTable: make firstName and lastName required
ALTER TABLE "User" ALTER COLUMN "firstName" SET NOT NULL,
ALTER COLUMN "lastName" SET NOT NULL;
