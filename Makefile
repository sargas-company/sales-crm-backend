.ONESHELL:
SHELL := /bin/bash

.PHONY: init backup deploy

# ─── Local dev init ───────────────────────────────────────────────────────────
init:
	@echo "Cleaning..."
	rm -rf node_modules
	rm -f package-lock.json
	npm install
	npx prisma generate --config=./prisma.config.ts
	@if [ ! -f .env ]; then cp .env.example .env; fi

	@echo "Starting Docker containers..."
	docker compose up -d --build

	@echo "Waiting for database to be ready..."
	sleep 10

	@echo "Running Prisma migrations..."
	npx prisma migrate reset --force --config=./prisma.config.ts

	@echo "Seeding database..."
	npx prisma db seed --config=./prisma.config.ts

	@echo "Done."

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
