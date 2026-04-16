-- ─── Step 1: store platform slugs in temp columns before dropping enum ────────

ALTER TABLE "Account" ADD COLUMN "_pslug" TEXT;
ALTER TABLE "Proposal" ADD COLUMN "_pslug" TEXT;

UPDATE "Account" SET "_pslug" = CASE WHEN "platform" = 'Upwork' THEN 'upwork' ELSE 'linkedin' END;
UPDATE "Proposal" SET "_pslug" = CASE WHEN "platform" = 'Upwork' THEN 'upwork' ELSE 'linkedin' END;

-- ─── Step 2: drop columns using the enum, then drop the enum ─────────────────

ALTER TABLE "Account" DROP COLUMN "platform",
                      DROP COLUMN "imageUrl";

ALTER TABLE "Proposal" DROP COLUMN "platform";

DROP TYPE "Platform";

-- ─── Step 3: create Platform table (name is now free) ────────────────────────

CREATE TABLE "Platform" (
    "id"        TEXT        NOT NULL,
    "title"     TEXT        NOT NULL,
    "slug"      TEXT        NOT NULL,
    "imageUrl"  TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),

    CONSTRAINT "Platform_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Platform_slug_key" ON "Platform"("slug");

INSERT INTO "Platform" ("id", "title", "slug", "updatedAt") VALUES
  ('00000000-0000-0000-0000-000000000001', 'Upwork',   'upwork',   NOW()),
  ('00000000-0000-0000-0000-000000000002', 'LinkedIn', 'linkedin', NOW());

-- ─── Step 4: add platformId FK columns and populate from temp slugs ───────────

ALTER TABLE "Account"  ADD COLUMN "platformId" TEXT;
ALTER TABLE "Proposal" ADD COLUMN "platformId" TEXT;

UPDATE "Account"  a  SET "platformId" = p.id FROM "Platform" p WHERE p.slug = a."_pslug";
UPDATE "Proposal" pr SET "platformId" = p.id FROM "Platform" p WHERE p.slug = pr."_pslug";

-- Fill any remaining nulls with Upwork
UPDATE "Account"  SET "platformId" = '00000000-0000-0000-0000-000000000001' WHERE "platformId" IS NULL;

-- ─── Step 5: cleanup temp columns, add constraints ───────────────────────────

ALTER TABLE "Account"  DROP COLUMN "_pslug";
ALTER TABLE "Proposal" DROP COLUMN "_pslug";

ALTER TABLE "Account" ALTER COLUMN "platformId" SET NOT NULL;

ALTER TABLE "Account" ADD CONSTRAINT "Account_platformId_fkey"
  FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_platformId_fkey"
  FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Step 6: index (only if not exists) ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");
