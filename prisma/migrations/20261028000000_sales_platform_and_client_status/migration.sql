-- Sales rebrand migration.
--
-- Adds:
--   1. `platformId` nullable FK on Lead and Client (SET NULL on
--      Platform delete, so losing a Platform never cascades into a
--      Lead or a Client).
--   2. `CLIENT` value in the LeadStatus enum. Added to the END of
--      the enum so existing enum ordering is preserved.
--
-- No data is touched: existing Lead and Client rows keep
-- platformId=NULL; no status value is auto-rewritten.

-- 1. Platform FK on Lead.
ALTER TABLE "Lead" ADD COLUMN "platformId" TEXT;
ALTER TABLE "Lead"
  ADD CONSTRAINT "Lead_platformId_fkey"
  FOREIGN KEY ("platformId") REFERENCES "Platform"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Lead_platformId_idx" ON "Lead"("platformId");

-- 2. Platform FK on Client.
ALTER TABLE "Client" ADD COLUMN "platformId" TEXT;
ALTER TABLE "Client"
  ADD CONSTRAINT "Client_platformId_fkey"
  FOREIGN KEY ("platformId") REFERENCES "Platform"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Client_platformId_idx" ON "Client"("platformId");

-- 3. LeadStatus += CLIENT. ADD VALUE cannot run inside a BEGIN/COMMIT
--    with other statements under some Postgres versions; it's safe
--    here because Prisma's migration runner wraps the whole file in
--    a single transaction only when the statement list permits it,
--    and ADD VALUE at the end of the file is the standard pattern.
ALTER TYPE "LeadStatus" ADD VALUE 'CLIENT';
