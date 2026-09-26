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

# ─── Manual backup ────────────────────────────────────────────────────────────
backup:
	@echo "Creating manual backup..."
	npx ts-node -r tsconfig-paths/register scripts/backup.ts
	@echo "Done."

# ─── Sentinel: npm install only when deps change ──────────────────────────────
node_modules/.install-stamp: package.json package-lock.json
	. $$HOME/.nvm/nvm.sh && nvm use 20 --silent
	npm install
	touch node_modules/.install-stamp

# ─── Deploy ───────────────────────────────────────────────────────────────────
deploy: node_modules/.install-stamp
	. $$HOME/.nvm/nvm.sh && nvm use 20 --silent
	@echo "Node $$(node -v) | npm $$(npm -v)"

	@echo "=== Step 1/6: backup ==="
	$(MAKE) backup

	@echo "=== Step 2/6: validate prisma schema ==="
	npx prisma validate --config=./prisma.config.ts

	@echo "=== Step 3/6: migrate ==="
	npx prisma migrate deploy --config=./prisma.config.ts

	@echo "=== Step 4/6: generate prisma client ==="
	npx prisma generate --config=./prisma.config.ts

	@echo "=== Step 5/6: build ==="
	npm run build

	@echo "=== Step 6/6: restart ==="
	pm2 restart all

	@echo "=== Deploy complete ==="
