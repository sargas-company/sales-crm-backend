-- Create the service catalogue table.
CREATE TABLE "PhoneService" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneService_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhoneService_slug_key" ON "PhoneService"("slug");
CREATE INDEX "PhoneService_name_idx" ON "PhoneService"("name");

-- Data-migrate existing free-text serviceName values into the catalogue.
-- One PhoneService per distinct trimmed serviceName; slug derived by
-- lowercasing, trimming, collapsing non-alphanumerics into "_", and
-- stripping leading non-letters. Blanks and pure-digit leaders get a
-- stable fallback.
WITH distinct_services AS (
    SELECT DISTINCT TRIM("serviceName") AS raw_name
    FROM "PhoneNumberBinding"
    WHERE "serviceName" IS NOT NULL AND TRIM("serviceName") <> ''
),
slugged AS (
    SELECT
        raw_name,
        -- lowercase → replace any run of non [a-z0-9_] with "_"
        -- → collapse multiple "_" → trim leading/trailing "_"
        -- → strip leading non-letters.
        regexp_replace(
            regexp_replace(
                regexp_replace(
                    regexp_replace(lower(raw_name), '[^a-z0-9_]+', '_', 'g'),
                    '_+', '_', 'g'
                ),
                '^_+|_+$', '', 'g'
            ),
            '^[^a-z]+', '', 'g'
        ) AS base_slug
    FROM distinct_services
),
with_fallback AS (
    SELECT
        raw_name,
        CASE
            WHEN base_slug = '' THEN 'service_' || substr(md5(raw_name), 1, 8)
            ELSE base_slug
        END AS slug
    FROM slugged
)
INSERT INTO "PhoneService" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, raw_name, slug, now(), now()
FROM with_fallback
-- If two different raw names map to the same slug, dedupe on slug first
-- and keep the first lexicographic name; its slug stays canonical, and
-- the second migration below rewires every binding that was pointing
-- at the dropped twin.
ON CONFLICT ("slug") DO NOTHING;

-- Add the FK column, backfill, then enforce NOT NULL and the FK.
ALTER TABLE "PhoneNumberBinding" ADD COLUMN "serviceId" TEXT;

UPDATE "PhoneNumberBinding" b
SET "serviceId" = s."id"
FROM "PhoneService" s
WHERE TRIM(b."serviceName") = s."name";

-- Any binding whose old serviceName slug clashed with another will not
-- have matched by exact name. Resolve by slug.
UPDATE "PhoneNumberBinding" b
SET "serviceId" = s."id"
FROM "PhoneService" s
WHERE b."serviceId" IS NULL
  AND s."slug" = regexp_replace(
        regexp_replace(
            regexp_replace(
                regexp_replace(lower(TRIM(b."serviceName")), '[^a-z0-9_]+', '_', 'g'),
                '_+', '_', 'g'
            ),
            '^_+|_+$', '', 'g'
        ),
        '^[^a-z]+', '', 'g'
      );

-- Last-ditch backfill: any binding still unlinked (e.g. empty
-- serviceName) gets attached to a synthetic "unknown" service so
-- NOT NULL + FK can be enforced without losing rows.
DO $$
DECLARE
    unknown_id TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM "PhoneNumberBinding" WHERE "serviceId" IS NULL) THEN
        SELECT "id" INTO unknown_id FROM "PhoneService" WHERE "slug" = 'unknown';
        IF unknown_id IS NULL THEN
            INSERT INTO "PhoneService" ("id", "name", "slug", "createdAt", "updatedAt")
            VALUES (gen_random_uuid()::text, 'Unknown', 'unknown', now(), now())
            RETURNING "id" INTO unknown_id;
        END IF;
        UPDATE "PhoneNumberBinding" SET "serviceId" = unknown_id WHERE "serviceId" IS NULL;
    END IF;
END $$;

-- Enforce NOT NULL and attach the FK.
ALTER TABLE "PhoneNumberBinding" ALTER COLUMN "serviceId" SET NOT NULL;

ALTER TABLE "PhoneNumberBinding"
ADD CONSTRAINT "PhoneNumberBinding_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "PhoneService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replace the old serviceName index with the new serviceId one.
DROP INDEX IF EXISTS "PhoneNumberBinding_serviceName_idx";
CREATE INDEX "PhoneNumberBinding_serviceId_idx" ON "PhoneNumberBinding"("serviceId");

-- Finally drop the free-text column.
ALTER TABLE "PhoneNumberBinding" DROP COLUMN "serviceName";
