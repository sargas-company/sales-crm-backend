# Sargas CRM — Backend

> ⚠️ Описание «AI Proposal Assistant» ниже устарело: проект вырос в
> internal CRM (Sales / Leads / Clients / Projects / Finance /
> Discord). Канонический обзор архитектуры — workspace-файл
> `docs/architecture/overview.md`; операционный канон —
> `docs/ops/production.md` (оба уровнем выше этого репозитория).

## Стек

- **NestJS 11** — фреймворк
- **PostgreSQL 16** — БД (vector-полей нет; pgvector нужен только
  init-миграции при деплое с нуля)
- **Prisma 6** — ORM
- **Redis + BullMQ** — очереди (`notifications`, `job-post-processing`)
- **Anthropic SDK** — двухступенчатый AI-анализ Job Posts
  (gatekeeper → evaluator); OpenAI/эмбеддинги/RAG удалены вместе с
  legacy-чатом
- **Discord Bot API** — уведомления и `/report`
- **JWT** — access token (1h) + refresh token (30d)

## Быстрый старт

Локальный запуск идёт через явно охраняемые `make`-цели. Подробный
пошаговый гид с ожидаемым выводом каждого шага —
[`docs/local-setup.md`](docs/local-setup.md).

```bash
make setup          # npm ci + prisma generate + .env из .env.example (если .env ещё нет)
make local-up       # docker compose up -d (Postgres + Redis)
make local-migrate  # запускает guard, затем prisma migrate dev
make local-seed     # запускает guard, затем prisma db seed
npm run start:dev   # старт NestJS
```

Гвард `scripts/assert-local-db.ts` проверяет пять сигналов
(`APP_ENV=local`, парсимый Postgres URL, host из
`{localhost, 127.0.0.1, ::1}`, порт `5433`, БД `ai_dashboard`) и
завершается с ошибкой, если хотя бы один не совпал — так исключается
случайный `prisma migrate dev` против чужой базы.

Для полного пересоздания локальной БД (drop + мигрировать + сидировать)
используйте `make local-reset`. Цель запрашивает у оператора ввести
имя БД вручную; любое несовпадение (включая пустой ввод) прерывает
сброс до вызова Prisma.

Дополнительные локальные цели: `make local-down` (остановить контейнеры,
volumes сохраняются), `make local-logs` (`docker compose logs -f`).

> Deprecation-заглушки — только `make init` и `make deploy`.
> `make backup` — **рабочая** цель (pg_dump → B2 c верификацией).
> Операторские `make prod-*` цели существуют; production-процедуры —
> в workspace-файле `docs/ops/production.md` (старый
> `docs/runbooks/production-deploy.md` упразднён и оставлен
> указателем).

## Сервисы

| Сервис | Адрес |
|---|---|
| REST API | `http://localhost:3000` |
| Swagger | `http://localhost:3000/swagger` |

> Swagger доступен при `NODE_ENV` ≠ `production`. WebSocket удалён
> вместе с legacy-чатом; realtime — единственный SSE-эндпоинт
> `GET /analytics/stream`.

## Основные эндпоинты

```
POST   /auth/login              — логин, возвращает accessToken + refreshToken
POST   /auth/refresh            — обновить пару токенов
POST   /auth/logout             — инвалидировать refresh token

GET    /platforms               — список платформ
POST   /platforms               — создать платформу

GET    /accounts                — аккаунты текущего пользователя
POST   /accounts                — создать аккаунт

POST   /proposals               — создать proposal (title, accountId, platformId, ...)
GET    /proposals               — все proposals с пагинацией
PUT    /proposals/:id           — обновить (смена статуса → автоматически создаёт Lead)
DELETE /proposals/:id           — удалить
GET    /proposals/:id/chat      — история чата с decision и reasoning
POST   /proposals/:id/analyze   — только анализ, без генерации текста

GET    /leads                   — все leads с пагинацией
GET    /leads/:id               — lead
PATCH  /leads/:id               — обновить статус, имя, ставку и т.д.
DELETE /leads/:id               — удалить
GET    /leads/:id/activity      — activity timeline (AuditEvent)
```

Это лишь срез — полная актуальная поверхность API (44 модуля: clients,
client-requests, client-calls, attachments, invoices, projects,
employees, linkedin, phone-numbers, credentials vault, analytics/SSE и
т.д.) — в Swagger и в workspace-файле `docs/architecture/overview.md`.
Legacy-эндпоинты чатов/базы знаний удалены (`legacy-cleanup`).

## Тесты

```bash
npm run test
npm run test:e2e
```
