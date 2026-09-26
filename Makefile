.ONESHELL:
SHELL := /bin/bash

.PHONY: setup local-up local-down local-logs local-migrate local-seed local-reset init backup deploy

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
# up / down operate on the compose stack; named volumes survive `down`.
local-up:
	docker compose up -d

local-down:
	docker compose down

local-logs:
	docker compose logs -f

# ─── Guarded local DB operations ─────────────────────────────────────────────
# Every recipe runs scripts/assert-local-db.ts (the five-signal guard from
# T-02) before Prisma. `set -e` ensures a guard failure aborts the recipe
# before Prisma is invoked. `local-reset` additionally prompts the operator
# to type the local database name reported by the guard; a mismatch (or
# empty input) aborts before reset.
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

# ─── Deprecation stub: init ──────────────────────────────────────────────────
# `make init` was a destructive bootstrap. It is replaced by `make setup`
# plus the local-* targets. This stub exits non-zero so any lingering
# caller fails loudly.
init:
	@echo "make init is deprecated — use 'make setup' (installs deps, generates prisma client,"
	@echo "seeds .env if absent). For local Docker infra: make local-up / local-down / local-logs."
	@exit 1

# ─── Deprecation stub: backup ────────────────────────────────────────────────
# `make backup` used to run scripts/backup.ts (pg_dump + B2 upload). It is now
# a deprecation stub. Operators may still invoke `scripts/backup.ts` directly
# when a manual backup is required — see docs/runbooks/production-deploy.md
# (added by T-06).
backup:
	@echo "make backup is deprecated. Follow docs/runbooks/production-deploy.md for the"
	@echo "manual procedure. Operators may still invoke scripts/backup.ts directly."
	@exit 1

# ─── Deprecation stub: deploy ────────────────────────────────────────────────
# `make deploy` used to chain backup + prisma migrate deploy + build + pm2
# restart. Operational production commands are deferred to a later feature.
# See docs/runbooks/production-deploy.md (added by T-06) for the manual
# procedure. The node_modules/.install-stamp sentinel that fed this recipe
# has been removed alongside it.
deploy:
	@echo "make deploy is deprecated. Operational production commands are deferred to a"
	@echo "later feature. Follow docs/runbooks/production-deploy.md for the manual procedure."
	@exit 1
