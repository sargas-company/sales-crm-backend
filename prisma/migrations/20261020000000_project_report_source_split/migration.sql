-- Split ProjectReport by source: MANUAL (CRM UI, author = Employee) vs
-- DISCORD (slash command, author = Discord user; no Employee FK). The
-- migration also drops the never-exposed Employee.discordUserId column.

-- 0. Pre-check: refuse to drop Employee.discordUserId if anything has
-- been stored under it. The field was added for an un-launched
-- integration — expected 0 rows.
DO $$
DECLARE
    n INT;
BEGIN
    SELECT COUNT(*) INTO n FROM "Employee" WHERE "discordUserId" IS NOT NULL;
    IF n > 0 THEN
        RAISE EXCEPTION
            'Refusing to drop Employee.discordUserId: % non-null row(s) present. Clear them manually, then re-run.',
            n;
    END IF;
END $$;

-- 1. Enum for ProjectReport.source.
CREATE TYPE "ProjectReportSource" AS ENUM ('MANUAL', 'DISCORD');

-- 2. Add source + Discord provenance columns.
ALTER TABLE "ProjectReport"
    ADD COLUMN "source"          "ProjectReportSource" NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN "discordUserId"   TEXT,
    ADD COLUMN "discordUsername" TEXT;

-- 3. Make employeeId nullable so DISCORD rows can leave it NULL.
ALTER TABLE "ProjectReport" ALTER COLUMN "employeeId" DROP NOT NULL;

-- 4. Replace the composite unique with two partial uniques:
--      MANUAL  → one row per (project, employee, date)
--      DISCORD → one row per (project, date)
-- Prisma generates the composite unique as a plain unique INDEX, not a
-- table constraint, so DROP INDEX is the correct form here.
DROP INDEX "ProjectReport_projectId_employeeId_reportDate_key";

CREATE UNIQUE INDEX "ProjectReport_manual_uq"
    ON "ProjectReport" ("projectId", "employeeId", "reportDate")
    WHERE "source" = 'MANUAL';

CREATE UNIQUE INDEX "ProjectReport_discord_uq"
    ON "ProjectReport" ("projectId", "reportDate")
    WHERE "source" = 'DISCORD';

-- 5. Shape invariant — enforced at the DB level so no code path can
-- land a half-filled row.
ALTER TABLE "ProjectReport"
    ADD CONSTRAINT "ProjectReport_source_shape_chk" CHECK (
        (source = 'MANUAL'
            AND "employeeId"      IS NOT NULL
            AND "discordUserId"   IS NULL
            AND "discordUsername" IS NULL)
        OR
        (source = 'DISCORD'
            AND "employeeId"      IS NULL
            AND "discordUserId"   IS NOT NULL)
    );

-- 6. Drop the Employee.discordUserId column that is no longer needed —
-- /report no longer resolves the author to an Employee.
DROP INDEX IF EXISTS "Employee_discordUserId_key";
ALTER TABLE "Employee" DROP COLUMN "discordUserId";
