# Production deploy runbook — DEPRECATED

> **Deprecated 2026-10-12.** This runbook had drifted from the code
> (wrong backup env vars — the scripts require `B2_BACKUP_KEY_ID` /
> `B2_BACKUP_APP_KEY`, not the runtime pair; wrong health path — the
> real endpoint is `GET /health`; it called the working `make backup`
> a stub and the existing `make prod-*` targets "deferred").
>
> **The canonical operational reference is the workspace file
> `docs/ops/production.md`** (one level above this repo). Everything
> unique from this runbook was merged there: the ATTACHMENTS_DIR
> first-release setup, the "old code on new schema" window rationale
> (build before migrate), the rollback paths A/B/C with the
> enum-compatibility checks (`LeadStatus.CLIENT`, `CALL_*`
> notification types, the `gigRadarScore` drop), and the failed-
> migration `prisma migrate resolve` procedure.
>
> On a standalone checkout of this repo (without the workspace), use
> `make help` and the root workspace `README.md` owner guide; do not
> follow the pre-2026-10-12 revisions of this file.

The Discord integration runbook (`discord-integration.md`) remains
current.
