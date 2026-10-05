-- Add optional company column to Counterparty. Nullable so existing rows
-- (individuals without a company) remain valid. Display formatter shows
-- "Company · First Last" when set, "First Last" otherwise.
ALTER TABLE "Counterparty" ADD COLUMN "company" TEXT;
