# Sargas CRM — Backend rules

> Canonical brain, rules and project memory live **one level up** —
> start Claude sessions from the workspace root, not from this repo.

Nested under the workspace root. Workspace-level rules (git, security,
database, task flow, decisions, pattern map) live in
`../CLAUDE.md` and `../.claude/rules/`. **This file covers only the
backend stack.**

## Stack

- NestJS 11 · TypeScript (strict currently **off**) · Prisma 6 ·
  PostgreSQL 16 · Redis + BullMQ · Swagger · package manager **npm**.
- No Socket.IO and no pgvector columns since the legacy cleanup
  (migration `20260928101055`). The init migration still creates the
  `vector` extension, so a from-scratch deploy needs pgvector
  installed on the host.

## Conventions

- Follow the existing NestJS module / controller / service / DTO
  layout. Match a neighbouring module before inventing a new one.
- Validate every inbound DTO (`class-validator` on bodies / params /
  queries).
- Preserve the existing exception-filter shape. Don't change error
  response envelopes as a side effect of another change.
- Services access Prisma directly today. Don't introduce a global
  repository layer as a side effect.
- Don't enable `strict: true` globally as a side effect.

## API contracts

Frontend and backend are independent repos with duplicated API types
(see `../docs/architecture/overview.md`). Any contract change needs
coordinated changes in both repos as separate commits.

## Verification — read-only

- `npx prisma validate --config=./prisma.config.ts` — safe, touches
  nothing.
- `npm run typecheck` — n/a (project uses `tsc` through `nest build`;
  rely on build).

## Verification — writes files (not read-only)

- General rule: any command that writes files gets `git status --short`
  before and after; report the delta.
- `npm run build` writes/overwrites `dist/`. Don't stage `dist/`
  unless the task is shipping a build.
- `npm run lint` has `--fix` baked in and modifies files on the fly.
  **Never use as a read-only check.** Treat its diff as a code change.

## Verification — needs confirmed env (don't auto-run)

- `npm run test` — jest. Low coverage today, so green is a weak
  signal.
- `npm run test:e2e` — requires Postgres + Redis + app running; needs
  explicit user confirmation per session.

## Local operations — guarded Makefile

Local dev + infra go through named `make` targets in `Makefile`. Each
DB-touching target runs `scripts/assert-local-db.ts` first (five
signals: `APP_ENV=local`, parseable Postgres URL, host in
`{localhost,127.0.0.1,::1}`, port `5433`, database `ai_dashboard`).
Guard failure aborts before Prisma.

- `make setup` — `npm ci` + `prisma generate` + seed `.env` if
  absent. Idempotent.
- `make local-up / local-down / local-logs` — docker-compose
  Postgres + Redis.
- `make local-migrate` — guard, then `prisma migrate dev`.
- `make local-seed` / `make local-seed-demo` / `make local-seed-demo-crm` —
  guard, then seed.
- `make local-reset` — guard + typed-name confirmation, then
  `prisma migrate reset --force` (destructive). Interactive TTY only.
- `make backup` + `make backup-verify` + `make restore-verify` +
  `make restore-scratch` — B2-backed backup chain.
- `make preflight` / `make health` / `make status` — read-only ops.
- `make build` (= `npm run build`, writes `dist/`) and `make test`
  (= `npx jest`, needs the confirmed local test env) are **not**
  read-only — treat them like their npm counterparts.
- `make -n <target>` — safe dry-run to inspect what a target would do.
- DB-touching targets are never run automatically; each run needs the
  user's explicit ask in the current session.
- `make prod-bootstrap-preflight` / `make prod-preflight` /
  `make prod-migrate` / `make prod-seed-system` / `make prod-build` —
  server-side operator targets. **Don't run from a local shell;
  they belong to the operator on the prod host.**
- `make discord-status / discord-disable / discord-disable-apply` —
  Discord ops.

Deprecation stubs `make init` and `make deploy` print a message and
exit 1. Don't restore their prior behaviour.

## Database

Governed by `../.claude/rules/database.md`:

- **Production is off-limits by default.** Never infer target env
  from `DATABASE_URL` alone.
- **Forbidden during normal work:** `prisma db push`, direct
  `prisma migrate reset`, `DROP` / `TRUNCATE` / unqualified `DELETE`
  or `UPDATE` on real DBs, direct `prisma db seed` / `npm run seed`.
- Local `prisma migrate dev` only against a DB the user confirmed as
  local in **this** session.
- Production migrations go through: reviewed + committed migration →
  verified backup → `prisma migrate deploy`. Any missing step is a
  stop condition.
- `npx prisma format` modifies `schema.prisma` — treat as code
  change, not a check.
