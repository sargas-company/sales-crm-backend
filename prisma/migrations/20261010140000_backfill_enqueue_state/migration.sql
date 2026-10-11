-- Phase A — follow-up #5: legacy JobPost rows ingested before the
-- enqueueState column existed carry NULL in that column. For NEW
-- rows that is semantically "stored while AI was off" — i.e.
-- BACKLOG. If left as NULL, those rows disappear from the backlog
-- counter and from the enable-analysis modal, which is the opposite
-- of what the operator expects.
--
-- Terminal states (PROCESSED / FAILED / SKIPPED / PROCESSING) stay
-- NULL by design: enqueueState is relevant only while the row is
-- waiting for the AI handoff.
--
-- Idempotent: a repeat run touches zero rows.
UPDATE "JobPost"
SET "enqueueState" = 'BACKLOG'
WHERE "status" = 'NEW' AND "enqueueState" IS NULL;
