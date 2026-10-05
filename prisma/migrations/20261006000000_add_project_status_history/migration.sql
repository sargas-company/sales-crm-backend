-- ProjectStatusHistory: a lightweight audit-style log of Project.status
-- transitions. Each real update to Project.status writes one row via the
-- backend service (see project.service.ts). The initial baseline row for
-- every existing Project is inserted at the bottom of this migration.

CREATE TABLE "ProjectStatusHistory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectStatusHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectStatusHistory_projectId_effectiveAt_idx"
    ON "ProjectStatusHistory"("projectId", "effectiveAt");

CREATE INDEX "ProjectStatusHistory_effectiveAt_idx"
    ON "ProjectStatusHistory"("effectiveAt");

ALTER TABLE "ProjectStatusHistory"
    ADD CONSTRAINT "ProjectStatusHistory_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Baseline row for every existing Project. We use the project's current
-- status and createdAt as the effective date — that's honest ("as of the
-- creation of the audit trail, the project was in this status") and is
-- what all charts fall back to when no explicit transitions have been
-- recorded yet.
INSERT INTO "ProjectStatusHistory" (id, "projectId", status, "effectiveAt", "createdAt")
SELECT gen_random_uuid(), p.id, p.status, p."createdAt", now()
FROM "Project" p;
