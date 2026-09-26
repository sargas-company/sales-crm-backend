# AI Proposal Assistant — Backend

AI-инструмент для менеджеров: вместо 10–15 минут на обдумывание и написание ответа клиенту — 1–2 строки контекста и готовый текст за секунды.

## Что делает система

1. **Понимает ситуацию** — менеджер вставляет текст вакансии и пишет своё сообщение
2. **Принимает решение** — AI анализирует и выдаёт `bid / decline / clarify` с обоснованием
3. **Формирует ответ** — готовый текст с учётом базы знаний компании и системного промпта
4. **Сохраняет историю** — чат переходит из proposal в lead при получении ответа от клиента

## Стек

- **NestJS 11** — фреймворк
- **PostgreSQL 16 + pgvector** — БД + векторный поиск
- **Prisma** — ORM
- **Claude claude-sonnet-4-6** (Anthropic) — анализ и генерация
- **text-embedding-3-small** (OpenAI) — эмбеддинги для RAG
- **Socket.IO** — стриминг ответов в реальном времени
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

> `make init`, `make deploy`, `make backup` теперь являются
> deprecation-заглушками и завершаются с ненулевым кодом. Ручной
> production-деплой описан в
> [`docs/runbooks/production-deploy.md`](docs/runbooks/production-deploy.md);
> охраняемый production-набор команд отложен до отдельной feature.

## Сервисы

| Сервис | Адрес |
|---|---|
| REST API | `http://localhost:3000` |
| Swagger | `http://localhost:3000/swagger` |
| WebSocket | `http://localhost:3001` |

> Swagger доступен только при `NODE_ENV=development`

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
GET    /leads/:id               — lead с вложенным proposal
PATCH  /leads/:id               — обновить статус, имя, ставку и т.д.
DELETE /leads/:id               — удалить
GET    /leads/:id/chat          — история чата (сквозная с proposal)

GET    /chats                   — все чаты (?type=proposal|lead&cursor=...&limit=20)

POST   /base-knowledge          — добавить запись в базу знаний
GET    /base-knowledge          — список с пагинацией (?page=1&limit=8)
GET    /base-knowledge/search   — семантический поиск (?q=...)

PUT    /settings                — обновить системный промпт
```

Полная документация по API — [FRONTEND.md](FRONTEND.md)

Архитектура и алгоритмы — [ARCHITECTURE.md](ARCHITECTURE.md)

## WebSocket

Подключение требует передачи `accessToken`:

```js
const socket = io('http://localhost:3001', {
  auth: { token: accessToken }
});

socket.emit('send_message', { proposalId, content });

socket.on('analysis', ({ decision, reasoning }) => { ... }); // сначала
socket.on('chunk',    ({ text }) => { ... });                 // потом текст
socket.on('done',     () => { ... });
```

## Тесты

```bash
npm run test
npm run test:e2e
```
