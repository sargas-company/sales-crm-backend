-- ProjectReport contributors snapshot migration.
--
-- Transition from "report of an author" to "one project report per
-- (project, logical date) + immutable contributor snapshot".
--
-- Steps:
--   1. Pre-checks: no mixed MANUAL+DISCORD rows for the same
--      (projectId, reportDate); snapshot pre-migration totals used
--      by post-assertions.
--   2. New table `ProjectReportContributor` with its indexes.
--   3. Merge conflicting MANUAL groups ((projectId, reportDate)
--      with >1 rows) into a single canonical row — sum hours,
--      concat content deterministically, keep earliest createdAt
--      and latest updatedAt, back-link all contributors.
--   4. Backfill contributors for every surviving MANUAL row.
--   5. Backfill contributors for DISCORD rows from the project's
--      current ProjectMember set.
--   6. Drop legacy partial unique indexes + CHECK + employeeId FK/
--      column.
--   7. Add full `UNIQUE(projectId, reportDate)`.
--   8. Change ProjectReport→Project FK to ON DELETE RESTRICT.
--   9. Post-assertions: counts match, hours preserved, no orphan
--      contributors, every snapshot name is non-empty, final row
--      count equals the pre-migration unique (projectId, date) count.
--
-- The migration is production-safe: everything happens inside a
-- single implicit transaction (Prisma migrate wraps the file). On
-- any assertion failure the whole thing rolls back.

-- Idempotency sentinel: refuse to re-run if the new table already
-- carries data from a previous apply.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'ProjectReportContributor'
  ) THEN
    RAISE EXCEPTION
      'ProjectReportContributor already exists — this migration has already been applied.';
  END IF;
END $$;

-- ─── 1. Pre-checks + pre-migration snapshot ──────────────────────

-- Any (projectId, reportDate) with BOTH MANUAL and DISCORD rows is a
-- cross-source collision — merging those automatically would conflate
-- different hour totals. Abort so the operator decides.
DO $$
DECLARE
  mixed INT;
BEGIN
  SELECT COUNT(*) INTO mixed
    FROM (
      SELECT 1
        FROM "ProjectReport"
       GROUP BY "projectId", "reportDate"
      HAVING COUNT(*) FILTER (WHERE "source" = 'MANUAL') > 0
         AND COUNT(*) FILTER (WHERE "source" = 'DISCORD') > 0
    ) t;
  IF mixed > 0 THEN
    RAISE EXCEPTION
      'Refusing migration: % (projectId, reportDate) pair(s) contain both MANUAL and DISCORD rows. Resolve manually first.',
      mixed;
  END IF;
END $$;

-- Snapshot pre-migration totals in a temp table so the post-assertions
-- compare apples to apples even after the merges.
CREATE TEMP TABLE "_pre_migration_totals" AS
  SELECT
    (SELECT COUNT(*) FROM "ProjectReport")                              AS pre_rows,
    (SELECT COUNT(DISTINCT ("projectId", "reportDate")) FROM "ProjectReport") AS pre_unique_pd,
    (SELECT COALESCE(SUM("hours"), 0) FROM "ProjectReport")             AS pre_hours;

-- ─── 2. Contributor table ────────────────────────────────────────

CREATE TABLE "ProjectReportContributor" (
    "id"                UUID    NOT NULL DEFAULT gen_random_uuid(),
    "reportId"          TEXT    NOT NULL,
    "employeeId"        TEXT,
    "firstNameSnapshot" TEXT    NOT NULL,
    "lastNameSnapshot"  TEXT    NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectReportContributor_pkey" PRIMARY KEY ("id")
);

-- Store id as TEXT (Prisma uuid default is varchar); re-express.
ALTER TABLE "ProjectReportContributor"
    ALTER COLUMN "id" TYPE TEXT USING "id"::TEXT,
    ALTER COLUMN "id" DROP DEFAULT;

CREATE UNIQUE INDEX "ProjectReportContributor_reportId_employeeId_key"
    ON "ProjectReportContributor" ("reportId", "employeeId");

CREATE INDEX "ProjectReportContributor_employeeId_idx"
    ON "ProjectReportContributor" ("employeeId");

ALTER TABLE "ProjectReportContributor"
    ADD CONSTRAINT "ProjectReportContributor_reportId_fkey"
    FOREIGN KEY ("reportId") REFERENCES "ProjectReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectReportContributor"
    ADD CONSTRAINT "ProjectReportContributor_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. Pick canonical row for every MANUAL (projectId, date) group
-- and merge the losers into it. We materialise the grouping into a
-- temp table first so the subsequent writes are deterministic even
-- if row visibility would otherwise shift.
CREATE TEMP TABLE "_manual_canonicals" AS
WITH ranked AS (
  SELECT
    "id",
    "projectId",
    "reportDate",
    "employeeId",
    "hours",
    "content",
    "createdAt",
    "updatedAt",
    ROW_NUMBER() OVER (
      PARTITION BY "projectId", "reportDate"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY "projectId", "reportDate") AS group_size
    FROM "ProjectReport"
   WHERE "source" = 'MANUAL'
)
SELECT * FROM ranked;

-- For every conflicting group, update the canonical (rn=1) row with
-- merged hours/content/updatedAt. Content is concatenated by author
-- in canonical order (createdAt, id) so the result is deterministic.
UPDATE "ProjectReport" r
   SET "hours"     = agg.total_hours,
       "content"   = agg.merged_content,
       "updatedAt" = agg.max_updated_at
  FROM (
    SELECT
      c."projectId",
      c."reportDate",
      SUM(c."hours")                                          AS total_hours,
      MAX(c."updatedAt")                                      AS max_updated_at,
      -- Author-prefixed block per row, blank-line separated.
      STRING_AGG(
        COALESCE(e."firstName", '') || ' ' || COALESCE(e."lastName", '') || ':' || E'\n' || c."content",
        E'\n\n' ORDER BY c."createdAt" ASC, c."id" ASC
      )                                                       AS merged_content
      FROM "_manual_canonicals" c
      LEFT JOIN "Employee" e ON e."id" = c."employeeId"
     WHERE c.group_size > 1
     GROUP BY c."projectId", c."reportDate"
  ) agg
 WHERE r."projectId"  = agg."projectId"
   AND r."reportDate" = agg."reportDate"
   AND r."source"     = 'MANUAL'
   AND r."id"         = (
     SELECT c2."id"
       FROM "_manual_canonicals" c2
      WHERE c2."projectId"  = r."projectId"
        AND c2."reportDate" = r."reportDate"
        AND c2.rn           = 1
   );

-- Record every author of a conflicting group as a contributor on the
-- canonical row. `DISTINCT` is defensive; `_manual_canonicals` can
-- only produce one row per original ProjectReport so duplicates are
-- impossible, but the UNIQUE on (reportId, employeeId) would reject
-- them anyway.
INSERT INTO "ProjectReportContributor" ("id", "reportId", "employeeId", "firstNameSnapshot", "lastNameSnapshot", "createdAt")
SELECT DISTINCT ON (canonical.id, c."employeeId")
       gen_random_uuid()::TEXT,
       canonical."id",
       c."employeeId",
       COALESCE(e."firstName", ''),
       COALESCE(e."lastName",  ''),
       CURRENT_TIMESTAMP
  FROM "_manual_canonicals" c
  JOIN "_manual_canonicals" canonical
    ON canonical."projectId"  = c."projectId"
   AND canonical."reportDate" = c."reportDate"
   AND canonical.rn           = 1
  JOIN "Employee" e ON e."id" = c."employeeId"
 WHERE c.group_size > 1
 ORDER BY canonical.id, c."employeeId", c."createdAt" ASC, c."id" ASC;

-- Delete the non-canonical (losing) rows. CASCADE on employee FK
-- would otherwise be a non-issue (losers are MANUAL with a bound
-- employeeId), but we remove them explicitly before dropping the
-- column so the row counts match the pre-migration unique
-- (projectId, reportDate) count.
DELETE FROM "ProjectReport" r
 WHERE r."source" = 'MANUAL'
   AND EXISTS (
     SELECT 1
       FROM "_manual_canonicals" c
      WHERE c."id" = r."id"
        AND c.rn   > 1
   );

-- ─── 4. Backfill contributors for every surviving MANUAL row.
-- At this point every MANUAL row is either the only row for its
-- (project, date) OR it was the canonical of a merged group. For
-- groups the canonical already has all contributor rows from the
-- previous INSERT; here we add the per-row contributor for the
-- single-row (non-conflict) case. ON CONFLICT DO NOTHING is a safety
-- net — the canonical already got its own employeeId as part of the
-- group backfill, so single-row inserts cannot collide with it.
INSERT INTO "ProjectReportContributor" ("id", "reportId", "employeeId", "firstNameSnapshot", "lastNameSnapshot", "createdAt")
SELECT gen_random_uuid()::TEXT,
       r."id",
       r."employeeId",
       COALESCE(e."firstName", ''),
       COALESCE(e."lastName",  ''),
       CURRENT_TIMESTAMP
  FROM "ProjectReport" r
  JOIN "Employee" e ON e."id" = r."employeeId"
 WHERE r."source" = 'MANUAL'
   AND r."employeeId" IS NOT NULL
ON CONFLICT ("reportId", "employeeId") DO NOTHING;

-- ─── 5. DISCORD rows → snapshot the project's current team.
-- When a DISCORD-sourced report's project no longer has any
-- ProjectMember, we deliberately leave the contributor set empty —
-- there is no truthful snapshot to backfill, and inventing one would
-- silently misrepresent history. The post-migration report surfaces
-- these rows.
INSERT INTO "ProjectReportContributor" ("id", "reportId", "employeeId", "firstNameSnapshot", "lastNameSnapshot", "createdAt")
SELECT gen_random_uuid()::TEXT,
       r."id",
       pm."employeeId",
       COALESCE(e."firstName", ''),
       COALESCE(e."lastName",  ''),
       CURRENT_TIMESTAMP
  FROM "ProjectReport" r
  JOIN "ProjectMember" pm ON pm."projectId" = r."projectId"
  JOIN "Employee"      e  ON e."id"         = pm."employeeId"
 WHERE r."source" = 'DISCORD'
ON CONFLICT ("reportId", "employeeId") DO NOTHING;

-- ─── 6. Drop legacy constraints / indexes / column.

DROP INDEX IF EXISTS "ProjectReport_manual_uq";
DROP INDEX IF EXISTS "ProjectReport_discord_uq";

ALTER TABLE "ProjectReport"
    DROP CONSTRAINT IF EXISTS "ProjectReport_source_shape_chk";

ALTER TABLE "ProjectReport"
    DROP CONSTRAINT IF EXISTS "ProjectReport_employeeId_fkey";

DROP INDEX IF EXISTS "ProjectReport_employeeId_idx";

ALTER TABLE "ProjectReport"
    DROP COLUMN IF EXISTS "employeeId";

-- ─── 7. Full unique on (projectId, reportDate).

CREATE UNIQUE INDEX "ProjectReport_projectId_reportDate_key"
    ON "ProjectReport" ("projectId", "reportDate");

-- ─── 8. Project FK → RESTRICT (hard-delete with existing reports
-- becomes a 409, not a silent cascade).

ALTER TABLE "ProjectReport"
    DROP CONSTRAINT IF EXISTS "ProjectReport_projectId_fkey";

ALTER TABLE "ProjectReport"
    ADD CONSTRAINT "ProjectReport_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 9. Post-assertions.
DO $$
DECLARE
  v_pre_rows        INT;
  v_pre_unique_pd   INT;
  v_pre_hours       DOUBLE PRECISION;
  v_post_rows       INT;
  v_post_hours      DOUBLE PRECISION;
  dup_pairs         INT;
  orphan_contribs   INT;
  empty_names       INT;
BEGIN
  SELECT pre_rows, pre_unique_pd, pre_hours
    INTO v_pre_rows, v_pre_unique_pd, v_pre_hours
    FROM "_pre_migration_totals";

  SELECT COUNT(*), COALESCE(SUM("hours"), 0)
    INTO v_post_rows, v_post_hours
    FROM "ProjectReport";

  SELECT COUNT(*) INTO dup_pairs
    FROM (
      SELECT 1 FROM "ProjectReport"
       GROUP BY "projectId", "reportDate" HAVING COUNT(*) > 1
    ) t;

  SELECT COUNT(*) INTO orphan_contribs
    FROM "ProjectReportContributor" c
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectReport" r WHERE r."id" = c."reportId");

  SELECT COUNT(*) INTO empty_names
    FROM "ProjectReportContributor"
   WHERE COALESCE("firstNameSnapshot", '') = ''
     AND COALESCE("lastNameSnapshot",  '') = '';

  IF dup_pairs > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % (projectId, reportDate) pair(s) still duplicated after merge.', dup_pairs;
  END IF;
  IF v_post_rows <> v_pre_unique_pd THEN
    RAISE EXCEPTION 'Post-check failed: ProjectReport row count % does not match pre-migration unique pairs %.', v_post_rows, v_pre_unique_pd;
  END IF;
  IF ROUND(v_post_hours::NUMERIC, 4) <> ROUND(v_pre_hours::NUMERIC, 4) THEN
    RAISE EXCEPTION 'Post-check failed: hours total % does not match pre-migration % (delta=%).',
      v_post_hours, v_pre_hours, (v_post_hours - v_pre_hours);
  END IF;
  IF orphan_contribs > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % orphan contributor row(s) have no parent ProjectReport.', orphan_contribs;
  END IF;
  IF empty_names > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % contributor row(s) have empty snapshot names.', empty_names;
  END IF;
  RAISE NOTICE 'ProjectReport contributors migration OK: % rows (was %), % hours preserved.',
    v_post_rows, v_pre_rows, v_post_hours;
END $$;

DROP TABLE "_manual_canonicals";
DROP TABLE "_pre_migration_totals";
