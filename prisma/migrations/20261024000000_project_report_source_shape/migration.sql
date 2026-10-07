-- Re-add the ProjectReport source-shape invariant that was dropped in
-- 20261023000000_project_report_contributors (together with the
-- employeeId column it referenced). The new rule has nothing to do
-- with Employee any more — it pins the Discord provenance columns to
-- the DISCORD source alone, so no code path can land a MANUAL row with
-- Discord metadata attached (or a DISCORD row that forgot its user id).
--
-- `discordUsername` stays nullable for DISCORD rows — Discord's user
-- object sometimes omits a `global_name` and the username, so we treat
-- it as best-effort display only.

-- Pre-check: refuse to add the constraint if any live row already
-- violates it. The follow-up should be a no-op on a freshly-migrated
-- dev DB (no rows mix MANUAL + Discord metadata there), but a
-- paranoid guard protects against drift from a hand-edited local DB.
DO $$
DECLARE
  bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM "ProjectReport"
   WHERE NOT (
     (
       "source" = 'MANUAL'
       AND "discordUserId" IS NULL
       AND "discordUsername" IS NULL
     )
     OR
     (
       "source" = 'DISCORD'
       AND "discordUserId" IS NOT NULL
     )
   );
  IF bad > 0 THEN
    RAISE EXCEPTION
      'Refusing to add ProjectReport_source_shape_chk: % existing row(s) violate the invariant. Resolve manually first.',
      bad;
  END IF;
END $$;

ALTER TABLE "ProjectReport"
  ADD CONSTRAINT "ProjectReport_source_shape_chk" CHECK (
    (
      "source" = 'MANUAL'
      AND "discordUserId" IS NULL
      AND "discordUsername" IS NULL
    )
    OR
    (
      "source" = 'DISCORD'
      AND "discordUserId" IS NOT NULL
    )
  );
