# Local setup

Пошаговый гид для разработчика: как поднять backend локально с нуля
без риска задеть чужие/боевые базы.

## Требования

- Node.js 20+ и npm
- Docker + Docker Compose (Postgres 16 + Redis запускаются локально)
- Git

## 1. Клон и первичный setup

```bash
git clone <repo>
cd sales-crm-backend
make setup
```

`make setup` — идемпотентная цель. При первом вызове:

- `npm ci` — устанавливает зависимости по `package-lock.json`.
- `cp .env.example .env` — только если `.env` ещё не существует;
  существующий `.env` не перезаписывается.
- `npx prisma generate --config=./prisma.config.ts` — Prisma client.

Не запускает Docker и не касается БД. Первой строкой рецепта стоит
`set -e`, поэтому любая промежуточная ошибка прерывает выполнение —
финальное `Setup complete.` появляется только при полностью успешном
проходе.

## 2. `.env`

`make setup` создаст `.env` из шаблона. Ключевые переменные:

| Переменная | Значение для локальной разработки |
|---|---|
| `APP_ENV` | `local` (обязательно; иначе guard провалится) |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/ai_dashboard` |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | любые непустые строки |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | реальные ключи для AI-путей |

Порт `5433` — публикация Postgres-контейнера на хост (внутри
контейнера всё ещё `5432`). Guard `scripts/assert-local-db.ts`
принимает только этот порт.

## 3. Поднять инфраструктуру

```bash
make local-up      # docker compose up -d — Postgres + Redis
make local-logs    # docker compose logs -f — при необходимости
```

Именованные volumes (`pgdata`, `redisdata`) сохраняются между
перезапусками; `make local-down` останавливает контейнеры, но данные
БД не удаляет.

## 4. Миграции и сиды

```bash
make local-migrate  # guard → prisma migrate dev
make local-seed     # guard → prisma db seed
```

Обе цели сначала запускают гвард `assert-local-db.ts`. Если хотя бы
один из пяти сигналов (`APP_ENV=local`, парсимый Postgres URL, host
из `{localhost, 127.0.0.1, ::1}`, порт `5433`, БД `ai_dashboard`) не
совпадает — цель завершается с ошибкой до вызова Prisma, и в
терминал печатается имя провалившегося сигнала (без утечки URL,
пользователя или пароля).

## 5. Запуск сервера

```bash
npm run start:dev
```

Сервисы:

| Сервис | Адрес |
|---|---|
| REST API | `http://localhost:3000` |
| Swagger | `http://localhost:3000/swagger` (`NODE_ENV=development`) |
| WebSocket | `http://localhost:3001` |

## Локальный `make local-reset`

Полный сброс локальной БД (drop + migrate + seed):

```bash
make local-reset
```

Порядок:

1. Guard `assert-local-db.ts`. Провал → выход с ненулевым кодом.
2. Guard печатает `OK <db>@<host>:<port>` — цель захватывает имя БД
   в `DBNAME`.
3. Оператору предлагают ввести имя БД:
   `Type the database name to confirm (anything else aborts):`
   Ввод считывается через `IFS= read -r CONFIRM < /dev/tty`:
   - piped stdin не проходит (нужен реальный терминал);
   - пробелы вокруг ввода сохраняются (не обрезаются `read`);
   - при отсутствии `/dev/tty` (нет controlling terminal) чтение
     проваливается, и `set -e` прерывает рецепт до Prisma.
4. Любое несовпадение (в т.ч. пустой ввод) → `Confirmation mismatch — aborting.`, `exit 1`.
5. При совпадении: `npx prisma migrate reset --force`
   (seed запускается автоматически через `migrations.seed` в
   `prisma.config.ts`).

## Что нельзя запускать локально

- `make init`, `make deploy`, `make backup` — deprecation-заглушки,
  завершаются с ненулевым кодом.
- `prisma migrate reset` напрямую (в обход `make local-reset`) —
  формально работает, но обходит гвард и подтверждение. Используйте
  цель.

## Troubleshooting

- **`assert-local-db: APP_ENV check failed`** — проверьте, что
  `APP_ENV=local` действительно в `.env` (первый шаг `make setup`).
- **`assert-local-db: port check failed`** — обычно `DATABASE_URL`
  указывает на `5432`, а docker-compose публикует на `5433`.
- **`assert-local-db: host check failed`** — использован не
  loopback-host. Если нужен `host.docker.internal`, расширение
  allow-list — одна строка в `scripts/assert-local-db.ts`.

## Тесты

```bash
npm run test
npm run test:e2e
```

`test:e2e` может обращаться к реальной БД — запускайте его только
после `make local-up` и явного подтверждения, что окружение
локальное.
