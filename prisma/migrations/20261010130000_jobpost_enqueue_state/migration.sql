-- Phase A follow-up: durable outbox-style state for the Redis handoff.
--
-- Why: Postgres and Redis are two systems; `enqueuedAt` alone cannot
-- tell "we committed the row and should push it to Redis" apart from
-- "we committed the row and the operator must decide first". Without
-- that distinction a transient Redis outage silently loses posts.
--
-- Model:
--   • `JobPostEnqueueState` is a small enum stored on JobPost.
--   • Ingestion while AI is paused ⇒ `BACKLOG`. Nothing pushes to
--     Redis until the operator picks a strategy.
--   • Ingestion while AI is active ⇒ `PENDING`. A scheduler tick
--     is the authority that pushes the row to Redis; a crash or
--     transient Redis failure leaves the row PENDING for the next
--     tick.
--   • After successful handoff to Redis ⇒ `ENQUEUED`.
--   • Terminal states (`PROCESSED`, `FAILED`, `SKIPPED`) carry
--     `enqueueState = NULL`.
--
-- Additive: existing rows get NULL. The processor + scheduler treat
-- NULL as "no action" so legacy rows keep their current semantics.

CREATE TYPE "JobPostEnqueueState" AS ENUM (
  'BACKLOG',
  'PENDING',
  'ENQUEUED'
);

ALTER TABLE "JobPost"
  ADD COLUMN "enqueueState" "JobPostEnqueueState";

CREATE INDEX IF NOT EXISTS "JobPost_enqueueState_idx"
  ON "JobPost"("enqueueState");

-- Composite index for the two queries the scheduler + stats endpoint
-- hit on every tick: "which NEW rows still need to be pushed?" and
-- "backlog counter".
CREATE INDEX IF NOT EXISTS "JobPost_status_enqueueState_idx"
  ON "JobPost"("status", "enqueueState");
