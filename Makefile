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
