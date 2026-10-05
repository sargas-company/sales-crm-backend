.ONESHELL:
SHELL := /bin/bash

.PHONY: help status health preflight build test \
        setup local-up local-down local-logs \
        local-migrate local-seed local-seed-demo local-reset \
        backup backup-status backup-verify \
        restore-verify restore-scratch \
        prod-preflight prod-migrate prod-build prod-seed-system \
        data-dry-run data-apply \
        discord-status discord-disable discord-disable-apply \
        b2-inventory \
        init deploy

# ─── Help ────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "Sargas CRM backend — operator commands"
	@echo ""
	@echo "General:"
	@echo "  make help                 This message."
	@echo "  make status               Git branch + last 3 commits in this repo."
	@echo "  make health               curl local backend /health (requires it to be running)."
	@echo "  make preflight            Read-only sanity: prisma validate + no .env in git."
	@echo "  make build                Backend build (nest build)."
	@echo "  make test                 Backend unit tests (jest)."
	@echo ""
	@echo "Local development (loud guards against prod):"
	@echo "  make setup                npm ci + prisma generate; seeds .env if missing."
	@echo "  make local-up/down/logs   docker compose up/down/logs for Postgres+Redis."
	@echo "  make local-migrate        LOCAL ONLY — prisma migrate dev + assert-local-db."
	@echo "  make local-seed           LOCAL ONLY — full seed (demo users, business data)."
	@echo "  make local-seed-demo      LOCAL ONLY — Employees/Projects/Reports demo rows."
	@echo "  make local-reset          LOCAL ONLY — DESTRUCTIVE drop+rebuild, typed confirm."
	@echo ""
	@echo "Backups:"
	@echo "  make backup               Create a MANUAL backup via scripts/backup.ts."
	@echo "  make backup-status        List last 10 BackupRun rows."
	@echo "  make backup-verify        Dry-run verify restore of latest VERIFIED backup."
	@echo "  make restore-verify BACKUP_ID=<id>"
	@echo "                            Verify a specific backup — no DB write."
	@echo "  make restore-scratch BACKUP_ID=<id> DATABASE_URL=<scratch-url>"
	@echo "                            Restore into a scratch LOCAL DB (name must end _restore_* / _scratch)."
	@echo ""
	@echo "Production (safe server-side ops — operator runs these on prod):"
	@echo "  make prod-preflight       Validate schema + confirm migrate deploy would run."
	@echo "  make prod-migrate         prisma migrate deploy (NOT dev / NOT reset / NOT push)."
	@echo "  make prod-seed-system     Idempotent system seed (permissions + roles + platform)."
	@echo "  make prod-build           nest build on the server."
	@echo ""
	@echo "Data operations (dry-run by default):"
	@echo "  make data-dry-run SCRIPT=<name>"
	@echo "                            Run scripts/<name>.ts in dry-run mode."
	@echo "  make data-apply SCRIPT=<name>"
	@echo "                            Run scripts/<name>.ts with --apply (requires confirmation)."
	@echo ""
	@echo "Discord integration:"
	@echo "  make discord-status       Print DiscordProfile table state (no secrets)."
	@echo "  make discord-disable      Dry-run: set every profile active=false + toggles=false."
	@echo "  make discord-disable-apply Apply the above (post-cutover safety reset)."
	@echo ""
	@echo "B2 cutover:"
	@echo "  make b2-inventory         DB-only report of expected B2 keys per bucket."
	@echo ""
	@echo "Deprecation stubs that still exist for muscle memory:"
	@echo "  make init / deploy / backup (deprecated)."

# ─── Repo status / health ────────────────────────────────────────────────────
status:
	@echo "branch: $$(git rev-parse --abbrev-ref HEAD)"
	@echo "head:   $$(git log -1 --oneline)"
	@echo ""
	@git log -3 --oneline

health:
	@set -e
	PORT=$${API_PORT:-3000}
	echo "Probing http://127.0.0.1:$$PORT/health …"
	CODE=$$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$$PORT/health" || echo "000")
	echo "HTTP $$CODE"
	if [ "$$CODE" != "200" ]; then
		echo "backend is not responding on :$$PORT"
		exit 1
	fi

preflight:
	@set -e
	echo "==> prisma validate"
	npx prisma validate --config=./prisma.config.ts
	echo "==> .env must NOT be tracked by git"
	if git ls-files --error-unmatch .env 2>/dev/null; then
		echo "SECURITY: .env is tracked in git; stop and remove it."
		exit 1
	fi
	echo "==> dist/ must be absent or ignored"
	if git ls-files dist/ 2>/dev/null | grep -q . ; then
		echo "WARNING: dist/ is tracked; expect noisy diffs."
	fi
	echo "preflight ok"

build:
	npm run build

test:
	npx jest

# ─── First-time / repeat local setup ─────────────────────────────────────────
# Non-destructive. Installs deps, generates the Prisma client, and copies
# .env.example -> .env only when .env is absent. Does not start Docker or
# touch the database.
setup:
	set -e
	@echo "==> npm ci"
	npm ci
	@if [ ! -f .env ]; then \
		echo "==> creating .env from .env.example"; \
		cp .env.example .env; \
	else \
		echo "==> .env already exists — leaving it alone"; \
	fi
	@echo "==> prisma generate"
	npx prisma generate --config=./prisma.config.ts
	@echo "Setup complete."

# ─── Local infra (docker compose) ────────────────────────────────────────────
local-up:
	docker compose up -d

local-down:
	docker compose down

local-logs:
	docker compose logs -f

# ─── Guarded local DB operations ─────────────────────────────────────────────
local-migrate:
	set -e
	@echo "==> assert local db"
	npx ts-node scripts/assert-local-db.ts
	@echo "==> prisma migrate dev"
	npx prisma migrate dev --config=./prisma.config.ts

local-seed:
	set -e
	@echo "==> assert local db"
	npx ts-node scripts/assert-local-db.ts
	@echo "==> prisma db seed"
	npx prisma db seed --config=./prisma.config.ts

local-seed-demo:
	set -e
	@echo "==> assert local db"
	npx ts-node scripts/assert-local-db.ts
	@echo "==> seed-employees-projects-demo"
	npx ts-node scripts/seed-employees-projects-demo.ts

local-reset:
	set -e
	@echo "==> assert local db"
	DBLINE=$$(npx ts-node scripts/assert-local-db.ts)
	@echo "$$DBLINE"
	DBNAME=$$(echo "$$DBLINE" | sed 's/^OK //; s/@.*//')
	@echo ""
	@echo "*** LOCAL RESET ***"
	@echo "This will drop and re-seed local database '$$DBNAME'."
	@echo "Type the database name to confirm (anything else aborts):"
	IFS= read -r CONFIRM < /dev/tty
	if [ "$$CONFIRM" != "$$DBNAME" ]; then
		echo "Confirmation mismatch — aborting."
		exit 1
	fi
	@echo "==> prisma migrate reset --force (drops all tables, applies migrations, re-seeds)"
	npx prisma migrate reset --force --config=./prisma.config.ts

# ─── Backups ─────────────────────────────────────────────────────────────────
# Direct invocation of the thin CLI wrappers in `scripts/`. They are the
# same code paths the deploy flow and tests exercise.

backup:
	@BACKUP_TYPE=$${BACKUP_TYPE:-MANUAL} BACKUP_TRIGGER=$${BACKUP_TRIGGER:-make} \
		npx ts-node scripts/backup.ts

backup-status:
	@npx ts-node -e "const p=new (require('@prisma/client').PrismaClient)(); p.backupRun.findMany({orderBy:{startedAt:'desc'},take:10,select:{id:true,type:true,status:true,environment:true,startedAt:true,size:true}}).then(r=>{console.log(JSON.stringify(r,(k,v)=>typeof v==='bigint'?v.toString():v,2))}).finally(()=>p.\$$disconnect());"

backup-verify:
	@set -e
	LATEST=$$(npx ts-node -e "const p=new (require('@prisma/client').PrismaClient)(); p.backupRun.findFirst({where:{status:'VERIFIED'},orderBy:{startedAt:'desc'},select:{id:true}}).then(r=>{if(!r){console.error('no VERIFIED backup found');process.exit(1)}console.log(r.id)}).finally(()=>p.\$$disconnect());")
	echo "latest VERIFIED backup: $$LATEST"
	npx ts-node scripts/restore.ts --backup-id=$$LATEST

restore-verify:
	@if [ -z "$(BACKUP_ID)" ]; then echo "Usage: make restore-verify BACKUP_ID=<uuid>"; exit 1; fi
	npx ts-node scripts/restore.ts --backup-id=$(BACKUP_ID)

restore-scratch:
	@if [ -z "$(BACKUP_ID)" ] || [ -z "$(DATABASE_URL)" ]; then \
		echo "Usage: make restore-scratch BACKUP_ID=<uuid> DATABASE_URL=postgres://…/dbname_restore_demo"; \
		echo "The target DB name MUST contain '_restore_' or '_scratch'. restore.ts enforces this."; \
		exit 1; \
	fi
	# Derive the typed-name confirmation from the URL's path segment.
	CONFIRM=$$(echo "$(DATABASE_URL)" | sed 's|^.*/\([^?]*\).*$$|\1|')
	npx ts-node scripts/restore.ts \
		--backup-id=$(BACKUP_ID) \
		--restore-to=$(DATABASE_URL) \
		--confirm=$$CONFIRM

# ─── Production (server-side; owner runs these on prod shell) ────────────────
# No SSH, no automatic connect. These targets simply call the same guarded
# scripts/commands the local path uses, except they expect APP_ENV=production.
prod-preflight:
	@set -e
	if [ "$$APP_ENV" != "production" ]; then
		echo "APP_ENV must be 'production' here. Got: '$$APP_ENV'"
		exit 1
	fi
	echo "==> prisma validate"
	npx prisma validate --config=./prisma.config.ts
	echo "==> require-fresh-backup"
	npx ts-node scripts/require-fresh-backup.ts
	echo "prod-preflight ok"

prod-migrate:
	@set -e
	if [ "$$APP_ENV" != "production" ]; then
		echo "APP_ENV must be 'production' here. Got: '$$APP_ENV'"
		exit 1
	fi
	echo "==> prisma migrate deploy (production)"
	npx prisma migrate deploy --config=./prisma.config.ts

prod-seed-system:
	@set -e
	if [ "$$APP_ENV" != "production" ]; then
		echo "APP_ENV must be 'production' here. Got: '$$APP_ENV'"
		exit 1
	fi
	echo "==> seed-system (idempotent, system data only)"
	npm run seed:system

prod-build:
	@set -e
	if [ "$$APP_ENV" != "production" ]; then
		echo "APP_ENV must be 'production' here. Got: '$$APP_ENV'"
		exit 1
	fi
	echo "==> nest build"
	npm run build

# ─── Data operations ────────────────────────────────────────────────────────
# Pass-through to any script in scripts/<name>.ts that follows the
# convention: dry-run by default, --apply to persist. The target does NOT
# invent new scripts; it is a safe launcher.

data-dry-run:
	@if [ -z "$(SCRIPT)" ]; then \
		echo "Usage: make data-dry-run SCRIPT=<name>  (looks up scripts/<name>.ts)"; \
		exit 1; \
	fi
	@if [ ! -f "scripts/$(SCRIPT).ts" ]; then \
		echo "scripts/$(SCRIPT).ts not found"; \
		exit 1; \
	fi
	npx ts-node scripts/$(SCRIPT).ts

data-apply:
	@if [ -z "$(SCRIPT)" ]; then \
		echo "Usage: make data-apply SCRIPT=<name>"; \
		exit 1; \
	fi
	@if [ ! -f "scripts/$(SCRIPT).ts" ]; then \
		echo "scripts/$(SCRIPT).ts not found"; \
		exit 1; \
	fi
	@echo "This will run scripts/$(SCRIPT).ts with --apply."
	@echo "Type APPLY to confirm:"
	IFS= read -r CONFIRM < /dev/tty
	if [ "$$CONFIRM" != "APPLY" ]; then echo "Aborted."; exit 1; fi
	npx ts-node scripts/$(SCRIPT).ts --apply

# ─── Discord ────────────────────────────────────────────────────────────────
discord-status:
	@npx ts-node -e "const p=new (require('@prisma/client').PrismaClient)(); p.discordProfile.findMany({orderBy:{name:'asc'},select:{name:true,active:true,reportsEnabled:true,birthdaysEnabled:true,absencesEnabled:true,weeklyEnabled:true,lastSuccessAt:true,lastFailureAt:true}}).then(r=>console.log(JSON.stringify(r,null,2))).finally(()=>p.\$$disconnect())"

discord-disable:
	npx ts-node scripts/discord-safe-disable.ts

discord-disable-apply:
	@echo "This will set active=false and ALL automation toggles=false on EVERY DiscordProfile."
	@echo "Type DISABLE to confirm:"
	IFS= read -r CONFIRM < /dev/tty
	if [ "$$CONFIRM" != "DISABLE" ]; then echo "Aborted."; exit 1; fi
	npx ts-node scripts/discord-safe-disable.ts --apply

# ─── B2 cutover inventory ───────────────────────────────────────────────────
b2-inventory:
	npx ts-node scripts/b2-cutover-inventory.ts

# ─── Deprecation stubs ──────────────────────────────────────────────────────
init:
	@echo "make init is deprecated — use 'make setup'."
	@exit 1

deploy:
	@echo "make deploy is deprecated — use 'make prod-preflight && make prod-migrate && make prod-build'."
	@echo "See README.md § production deployment for the full procedure."
	@exit 1
