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

backup:
	@echo "Creating manual backup..."
	npx ts-node -r tsconfig-paths/register scripts/backup.ts
	@echo "Done."

deploy:
	@echo "=== Step 1/5: backup ==="
	make backup
	@echo "=== Step 2/5: validate prisma schema ==="
	npx prisma validate --config=./prisma.config.ts
	@echo "=== Step 3/5: build ==="
	npm run build
	@echo "=== Step 4/5: migrate ==="
	npx prisma migrate deploy --config=./prisma.config.ts
	@echo "=== Step 5/5: restart ==="
	pm2 restart all
	@echo "=== Deploy complete ==="
