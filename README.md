# Sales CRM — Backend

AI-инструмент для менеджеров: вместо 10–15 минут на обдумывание и написание ответа клиенту — 1–2 строки контекста и готовый текст за секунды.

## Что делает система

1. **Понимает ситуацию** — менеджер вставляет текст вакансии и пишет своё сообщение
2. **Принимает решение** — AI анализирует и выдаёт `bid / decline / clarify` с обоснованием
3. **Формирует ответ** — готовый текст с учётом базы знаний компании и системного промпта
4. **Сохраняет историю** — чат переходит из proposal в lead при получении ответа от клиента

## Стек

| Слой | Технология |
|---|---|
| Фреймворк | NestJS 11 |
| БД | PostgreSQL 16 + pgvector (Docker) |
| ORM | Prisma 6 |
| Очереди | BullMQ + Redis (Docker) |
| AI генерация | Anthropic SDK (`claude-sonnet-4-6` по умолчанию) |
| AI эмбеддинги | OpenAI `text-embedding-3-small` |
| Real-time | Socket.IO |
| Хранилище файлов | Backblaze B2 |
| Уведомления | Discord webhook |
| Мониторинг | Sentry |
| Auth | JWT — access (1h) + refresh (30d) |

---

## Локальный запуск

### Требования

- Node.js 20+
- Docker + Docker Compose
- npm

### 1. Переменные окружения

```bash
cp .env.example .env
```

Заполни `.env` — описание каждой переменной в разделе [ENV](#env-переменные).

### 2. Быстрый старт (рекомендуется)

```bash
make init
```

Команда делает всё сразу: удаляет `node_modules`, ставит зависимости, поднимает Docker (PostgreSQL + Redis), ждёт готовности БД, применяет миграции и засевает начальные данные.

После этого запускай сервер:

```bash
npm run start:dev
```

### 3. Запуск вручную (по шагам)

```bash
npm install

# Поднять PostgreSQL + Redis
docker compose up -d

# Сгенерировать Prisma client
npx prisma generate --config=./prisma.config.ts

# Применить миграции
npx prisma migrate deploy --config=./prisma.config.ts

# Засеять начальные данные (платформы и т.д.)
npx prisma db seed --config=./prisma.config.ts

npm run start:dev
```

### Сервисы после запуска

| Сервис | URL |
|---|---|
| REST API | `http://localhost:3000` |
| Swagger | `http://localhost:3000/swagger` |
| WebSocket | `http://localhost:3001` |

> Swagger доступен только при `NODE_ENV=development`

---

## ENV переменные

Здесь только базовые переменные сервера. Переменные внешних сервисов описаны в разделе [Сторонние сервисы](#сторонние-сервисы) — каждый сервис со своими ключами в одном месте.

### База данных

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/ai_dashboard"
```

> Порт `5433` — Docker пробрасывает именно его (не 5432). Не меняй если не трогал `docker-compose.yml`.

### Сервер

```env
API_PORT=3000
SOCKET_IO_PORT=3001
NODE_ENV=development          # development | production

CORS_ORIGIN_1=http://localhost:5173   # фронт CRM
CORS_ORIGIN_2=http://localhost:5174   # лендинг sargas.io
```

### JWT

```env
JWT_SECRET=                   # любая длинная случайная строка
JWT_REFRESH_SECRET=           # другая случайная строка, не совпадает с JWT_SECRET
```

Сгенерировать можно так:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Redis

```env
REDIS_HOST=localhost
REDIS_PORT=6379
```

Redis используется для BullMQ (очередь Discord-уведомлений). Если Redis недоступен при старте — приложение упадёт. Убедись что `docker compose up -d` прошёл успешно.

---

## Сторонние сервисы

---

### Anthropic (Claude)

**Файлы:** `src/anthropic/anthropic.service.ts`, `src/chat/orchestrator/`

**ENV:**
```env
ANTHROPIC_API_KEY=sk-ant-...  # обязательный
CLAUDE_MODEL=                 # опционально — по умолчанию claude-sonnet-4-6
```

**Модели:**
- `claude-opus-4-6` — основной чат (генерация ответов менеджеру)
- `claude-sonnet-4-6` — классификация задач, фильтрация базы знаний, компрессия истории чатов (summary)

**Что делает:**
- Анализирует вакансии из Telegram → выдаёт `bid / decline / clarify` с обоснованием
- Генерирует ответы менеджеру в чате с учётом базы знаний и системного промпта
- Ежедневно сжимает историю активных чатов в `ChatSummary` чтобы Claude «помнил» длинные диалоги

**Cron — ежедневная компрессия истории чатов:**

Файл: `src/chat/orchestrator/summary.service.ts`
Расписание: каждый день в **00:00 UTC**

1. Находит все чаты с сообщениями за последние 24 часа
2. Берёт старые сообщения (исключая последние 20, которые идут в контекст напрямую)
3. Отправляет в `claude-sonnet-4-6` → получает сжатый summary
4. Сохраняет в таблицу `ChatSummary` (upsert по `chatId`)

Параллельность: батчи по 5 чатов. Summary также генерируется on-demand после каждых 20 новых сообщений в чате — не дожидаясь крона.

**Что будет без ключа:** чат, анализ вакансий и summary не работают — 500 на соответствующих эндпоинтах.

---

### OpenAI

**Файл:** `src/embedding/embedding.service.ts`

**ENV:**
```env
OPENAI_API_KEY=sk-...         # обязательный
```

**Модель:** `text-embedding-3-small`

**Что делает:** при добавлении записи в `base-knowledge` генерируется вектор и сохраняется в PostgreSQL через pgvector. При запросе к чату — по вектору ищутся релевантные фрагменты базы знаний и подмешиваются в промпт Claude.

**Что будет без ключа:** RAG не работает, `POST /base-knowledge` и `GET /base-knowledge/search` упадут.

---

### Backblaze B2

**Файл:** `src/storage/storage.service.ts`

**ENV:**
```env
B2_KEY_ID=                          # Application Key ID
B2_APP_KEY=                         # Application Key

B2_BUCKET_INVOICES_ID=e54d0c608de5ff319ed0011e
B2_BUCKET_INVOICES_NAME=sargas-crm-invoices-dev

B2_BUCKET_CLIENT_REQUESTS_ID=c57d9c108dd5ff319ed0011e
B2_BUCKET_CLIENT_REQUESTS_NAME=sargas-crm-client-requests-dev

B2_BUCKET_DB_DUMPS_ID=654d1c805d95ff319ed0011e
B2_BUCKET_DB_DUMPS_NAME=sargas-crm-backups-dev

```

**Три бакета:**

| Бакет | Что хранится |
|---|---|
| `INVOICES` | PDF-инвойсы |
| `CLIENT_REQUESTS` | файлы из форм с лендинга |
| `DB_DUMPS` | ежедневные дампы БД |

**Как работает:**
- При старте сервер авторизуется в B2 через `b2.authorize()`
- Upload URL кэшируется на 23 часа. При 401/503 — автоматический повтор с переавторизацией
- Скачивание через `GET /invoices/:id/pdf` → генерирует подписанный URL (действует 1 час)

**Cron — ежедневный бэкап БД:**

Файл: `src/database-backup/database-backup.service.ts`
Расписание: каждый день в **00:00 UTC**

1. Запускает `pg_dump -Fc` (custom compressed format — подходит для `pg_restore`)
2. Заливает дамп в бакет `DB_DUMPS`
3. Имя файла: `DD-MM-YYYY.dump`

При ошибке → пишет в Sentry с тегом `job: database-backup`.

**Важно:** версия `pg_dump` должна совпадать с PostgreSQL в Docker (**PostgreSQL 16**). Дамп от другой версии не восстановится.

```env
# macOS (Homebrew)
PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump

# Ubuntu / Linux
PG_DUMP_BIN=/usr/lib/postgresql/16/bin/pg_dump
```

Установить если не стоит:
```bash
# macOS
brew install postgresql@16

# Ubuntu
sudo apt install postgresql-client-16
```

---

### Discord

**Файл:** `src/notification/discord.service.ts`, `src/notification/notification.processor.ts`

**ENV:**
```env
DISCORD_WEBHOOK_URL=          # Incoming Webhook URL из настроек Discord-сервера
```

Webhook создаётся в Discord: **Настройки канала → Интеграции → Вебхуки → Создать вебхук**.

> Если переменная не задана — notification worker просто не стартует, приложение работает нормально.

**Уведомления через BullMQ:** события кладутся в Redis-очередь → worker забирает и шлёт POST на webhook. Каждое событие хранится в таблицах `NotificationEvent` + `NotificationDelivery` (статус: PENDING → SENT | FAILED). Дубли защищены на уровне БД.

**Cron — напоминания о звонках:**

Файл: `src/client-calls/call-reminder.service.ts`
Расписание: каждые **5 минут**, выровнено по границе интервала

При каждом тике проверяет два окна:
- звонки, которые начнутся через **60 минут** (±5 мин)
- звонки, которые начнутся через **10 минут** (±5 мин)

Повторная отправка защищена уникальным ключом в таблице `CallReminderSent` (`callId + reminderType`) — дубли невозможны даже при перезапуске.

**Три типа уведомлений:**

**`JOB_POST_MATCH` — новый подходящий job-post из Telegram**

Срабатывает когда AI оценил вакансию из Telegram-группы.

Содержимое embed:
- Заголовок и ссылка на пост
- **Score** с цветовой маркировкой: 🟢 ≥70% / 🟡 40–69% / 🔴 <40%
- **Decision**: ✅ approve / 🤔 maybe
- **Priority**: 🔴 high / 🟡 medium / 🟢 low
- Полный текст вакансии

Цвет embed: зелёный (approve) / жёлтый (maybe) / синий (остальное).

---

**`CALL_REMINDER` — напоминание о запланированном звонке**

Содержимое embed:
- Название звонка
- Имя клиента и тип (Lead / Client Request)
- Время клиента с его таймзоной
- Время по Киеву
- Длительность (минуты)
- Ссылка на встречу (если указана)

---

**`CLIENT_REQUEST` — новая заявка с лендинга**

Срабатывает когда кто-то заполняет форму обратной связи на sargas.io.

Содержимое embed:
- Имя и email
- Компания (если указана)
- Список интересующих сервисов
- Сообщение из формы

---

### invoice-generator.com

**Файл:** `src/invoice/invoice.service.ts`

**ENV:**
```env
INVOICE_GENERATOR_API_KEY=    # опционально — без ключа работает с лимитами
```

**Флоу генерации PDF:**

1. `POST /invoices/:id/generate` → бэкенд собирает payload с данными инвойса
2. Отправляет POST на `https://invoice-generator.com` → получает arraybuffer (PDF)
3. PDF заливается в Backblaze B2 (бакет `INVOICES`)
4. Имя файла: `{Тип} - {Имя} - {Месяц День, Год} ({shortId}).pdf`
5. В БД сохраняется `pdfUrl` (имя файла) + статус инвойса → `open`

Логотип в PDF подтягивается с `https://sargas.io/logo.png`.

> Нельзя поставить статус инвойса `paid` пока PDF не сгенерирован — бэкенд вернёт 400.

---

### Telegram

**Файл:** `src/telegram/telegram-listener.service.ts`

**ENV:**
```env
TG_API_ID=                    # из my.telegram.org → Apps
TG_API_HASH=                  # из my.telegram.org → Apps
TG_PHONE=                     # номер телефона аккаунта для парсинга
TG_GROUP=                     # username или числовой id группы
TG_BACKFILL_BATCH_SIZE=       # сколько постов брать за раз при backfill
TG_BACKFILL_BATCH_DELAY_MS=   # задержка между батчами (мс)
```

> Если все `TG_*` переменные пустые — сервис не стартует, приложение работает нормально.

**Как работает:**
- Использует библиотеку `telegram` (GramJS / MTProto) — это **не Bot API**, а полноценный пользовательский клиент
- Подключается к указанной группе и слушает новые сообщения в реальном времени
- При получении нового сообщения → создаёт `JobPost` со статусом `NEW`
- AI (Anthropic) оценивает вакансию → ставит `decision`, `matchScore`, `aiResponse`
- При положительном решении → Discord-уведомление `JOB_POST_MATCH`

**Первый запуск:**

При первом старте потребуется интерактивный ввод SMS-кода (Telegram пришлёт код на номер `TG_PHONE`). Сессия сохраняется локально. В продакшне держи файл сессии в постоянном месте (не теряй при деплое).

---

### Sentry

**Файл:** `src/instrument.ts` (инициализируется первым до загрузки NestJS), `src/common/http/global-exception.filter.ts`

**ENV:**
```env
SENTRY_DSN=                   # DSN из панели Sentry
APP_VERSION=                  # текущая версия (например 1.0.0) — попадает в release
```
можно не укзаывать тогда никакие ошибки в sentry не попадут

**Что перехватывает:**

| Источник | Условие | Теги |
|---|---|---|
| `GlobalExceptionFilter` | все HTTP-ошибки **≥ 500** | `service: crm-api`, `userId`, endpoint, method |
| Database Backup cron | любая ошибка дампа или загрузки | `job: database-backup` |
| Telegram listener | ошибки подключения и обработки | — |
| Job Post Processor | ошибки AI-оценки вакансий | — |

**Что НЕ попадает в Sentry:** 4xx ошибки (BadRequest, NotFound, Unauthorized) — только серверные.

**Настройки:**
- `tracesSampleRate: 0.05` — 5% трейсов (не перегружает квоту)
- Перед отправкой автоматически вырезаются заголовки `authorization` и `cookie`
- `environment` берётся из `NODE_ENV`, `release` — из `APP_VERSION`

---

## Health Check

**Файл:** `src/common/http/health.controller.ts`

**Эндпоинт:** `GET /health`

Делает `SELECT 1` к PostgreSQL и возвращает `{ status: "ok" }`. Используется для uptime-мониторинга, load balancer и Docker healthcheck.

```bash
curl http://localhost:3000/health
# { "status": "ok" }
```

Если БД недоступна — вернёт 500.

---

## Seeding

### Что создаёт seed

При запуске `npx prisma db seed --config=./prisma.config.ts` создаются:

| Данные | Стратегия | Что создаётся |
|---|---|---|
| Платформы | `upsert` по `id` | Upwork |
| Пользователи | `upsert` по `email` | `admin@test.com` (ADMIN), `manager@test.com` (MANAGER), `tg-bot@internal` (системный) |
| Аккаунты | `findFirst` + `create` если нет | Аккаунт Upwork для admin-пользователя |
| Промпты | upsert активного по типу | JOB_GATEKEEPER, JOB_EVALUATION, CHAT_SYSTEM, CHAT_FALLBACK, CHAT_CLASSIFIER, CHAT_SUMMARY, KNOWLEDGE_TITLE_FILTER, KNOWLEDGE_CONTENT_FILTER |
| База знаний | `upsert` по `id` | 27 документов (кейсы, bid-фрагменты) с префиксом `seed-knowledge-*` |
| Setting sections | `upsert` по `key` | general, ai, job_scanner, integrations, notifications, api_keys, invoice |
| Settings | `upsert` по `key` | настройки job_scanner и invoice |

Пароль seed-пользователей: **`admin123`**

### Безопасно ли запускать seed повторно

**Да, полностью безопасно.** Seed работает по принципу "создать если не существует" — существующие данные не дублируются и не перезаписываются:

- **Пользователи** — если `admin@test.com` уже есть, запись пропускается. Роль и имя, изменённые через API, остаются нетронутыми
- **Промпты** — если активный промпт данного типа уже есть, пропускается. Правки сделанные через UI (`/prompts`) сохраняются
- **Knowledge documents** с `id` вида `seed-knowledge-*` — если документ уже есть, пропускается. Правки сделанные через UI сохраняются. Документы добавленные через API (другой `id`) не затрагиваются

**Что seed не трогает никогда:** Proposals, Leads, Chats, ChatMessages, Invoices, ClientCalls, ClientRequests, Counterparties — их в seed нет.

### Опасность `make init`

`make init` запускает `migrate reset --force` **перед** seed — это дропает всю БД и применяет миграции с нуля. Все данные теряются.

Если нужно только пересеять без потери данных:
```bash
npx prisma db seed --config=./prisma.config.ts
```

### Как добавить нового пользователя

**Через API (рекомендуется):**
```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "...", "firstName": "...", "lastName": "...", "role": "MANAGER"}'
```

Такой пользователь seed никогда не перетрёт — в seed нет его email.

**Не добавляй реальных пользователей в `seed.ts`** — при следующем `make init` их данные сотрутся вместе со всей БД.

### Как добавить новые данные в seed (для dev-окружения)

Если нужно добавить тестовые данные которые должны быть у всех разработчиков — добавляй в `prisma/seed.ts` с `upsert` и фиксированным `id`. Никогда не используй `create` без проверки — на повторном запуске упадёт с unique constraint.

---

## Миграции

Конфиг Prisma загружается из `prisma.config.ts`, **не из `.env` напрямую**. Всегда передавай `--config`:

```bash
# Создать новую миграцию (dev)
npx prisma migrate dev --name <name> --config=./prisma.config.ts

# Применить существующие миграции (prod / CI)
npx prisma migrate deploy --config=./prisma.config.ts

# Сбросить БД и применить всё заново (только dev!)
npx prisma migrate reset --force --config=./prisma.config.ts

# Открыть Prisma Studio
npx prisma studio --config=./prisma.config.ts
```

> `migrate reset` удаляет все данные. Используй только в локальной разработке.

### Типичный workflow при изменении схемы

1. Поправить `prisma/schema.prisma`
2. `npx prisma migrate dev --name <что_изменил> --config=./prisma.config.ts`
3. Prisma сгенерирует migration SQL и обновит client автоматически

---

## Нюансы разработки

### pgvector

Docker-образ — `pgvector/pgvector:pg16`. Расширение включается автоматически через миграцию. Если поднимаешь PostgreSQL не через Docker — нужно установить `pgvector` вручную.

### Prisma config

Проект использует `prisma.config.ts` вместо стандартного `schema.prisma`-lookup:
- Все команды Prisma требуют `--config=./prisma.config.ts`
- `npx prisma generate` без флага может не найти схему

### Socket.IO

WebSocket и REST — на **разных портах** (`3000` и `3001`). Убедись что оба открыты в firewall в продакшне.

### Роли

Две роли: `ADMIN` и `MANAGER`. Создаются через `POST /auth/register`. Без роли в JWT большинство эндпоинтов недоступны.

---

## Деплой (Production)

### Структура на сервере

```
/var/www/
├── sales-crm/
│   ├── sales-crm-backend/          # API (NestJS)
│   └── sales-crm-frontend/         # фронт
└── ecosystemSalesCrm.config.js     # PM2 конфиг
```

### Обновить и задеплоить backend

```bash
cd /var/www/sales-crm/sales-crm-backend
sudo git pull
make deploy
```

`make deploy` выполняет пять шагов автоматически:

| Шаг | Что происходит |
|---|---|
| 1. backup | дамп БД заливается в Backblaze B2 |
| 2. validate | `prisma validate` — проверяет синтаксис схемы, падает до migrate если схема сломана |
| 3. build | компилируется TypeScript — если упадёт, БД не тронута |
| 4. migrate | применяются новые Prisma-миграции (только если код собрался) |
| 5. restart | `pm2 restart all` поднимает новый билд |

### Инфраструктура на сервере

- **Nginx** — принимает HTTPS и проксирует на порт **3006** (production `API_PORT`)
- **PM2** — управляет процессом Node.js, конфиг: `/var/www/ecosystemSalesCrm.config.js`
- **Docker** — держит PostgreSQL + Redis (не трогать без необходимости)

### Полезные PM2-команды

```bash
pm2 list                                        # статус всех процессов
pm2 logs                                        # логи в реальном времени
pm2 restart all                                 # перезапустить без деплоя
```

> **Первый запуск на новом сервере** — PM2 нужно запустить вручную:
> ```bash
> pm2 start /var/www/ecosystemSalesCrm.config.js
> pm2 save       # сохранить список процессов для автостарта
> pm2 startup    # зарегистрировать автостарт при перезагрузке сервера
> ```

### Осторожно — что нельзя делать без понимания последствий

**Локально:**

| Команда | Опасность |
|---|---|
| `make init` | `migrate reset --force` — **дропает всю БД**, все данные теряются безвозвратно |
| `docker compose down -v` | удаляет volumes — БД и Redis вместе с данными |
| `npx prisma migrate reset` | то же что `make init`, только без пересева |
| `npx prisma db seed` | перезаписывает промпты и роли seed-пользователей — потеряешь правки сделанные через UI |

**На проде:**

| Команда / действие | Опасность |
|---|---|
| `make init` на сервере | **никогда** — сотрёт продовую БД |
| `make deploy` без проверки миграций | если в ветке сломанная миграция — `migrate deploy` упадёт на полпути, сервис встанет |
| `pm2 restart all` | перезапускает **все** PM2-процессы на сервере, не только CRM |
| `docker compose down` на сервере | PostgreSQL и Redis упадут, сервис недоступен |
| потеря `.env` на сервере | все секреты (JWT, API-ключи, B2) нужно будет вводить заново вручную |
| потеря Telegram-сессии (`*.session`) | потребует повторной авторизации по SMS |

**Перед любым деплоем убедись:**
1. `make deploy` сам делает бэкап первым шагом — но проверь что бэкап прошёл успешно в логах
2. Миграции на локалке применялись без ошибок
3. Ветка собирается (`npm run build` без ошибок) — иначе `pm2 restart` поднимет сломанный билд

---

## Критические ситуации

### БД недоступна при старте

```bash
docker compose ps
docker compose restart db
docker compose logs db --tail=50
```

### Зависли миграции / БД в рассинхроне

```bash
npx prisma migrate status --config=./prisma.config.ts
npx prisma migrate deploy --config=./prisma.config.ts
```

### Redis недоступен — очереди не работают

```bash
docker compose restart redis
redis-cli -h localhost -p 6379 ping
```

### Сервер падает при старте (EADDRINUSE)

```bash
lsof -i :3000
kill -9 <PID>
```

### Потерян refresh token пользователя

Refresh токены хранятся в таблице `RefreshToken`. Удали запись — пользователь просто залогинится заново.

### Anthropic / OpenAI API недоступен

Сервер стартует нормально, упадёт только конкретный запрос. Ошибка пробрасывается в 503. Проверь ключи и баланс в консолях Anthropic / OpenAI.

### Полный сброс локальной среды

```bash
docker compose down -v   # удалить контейнеры И volumes (все данные БД!)
make init                # поднять заново с нуля
```

---

## Основные эндпоинты

```
POST   /auth/login              — логин → accessToken + refreshToken
POST   /auth/refresh            — обновить токены
POST   /auth/logout             — инвалидировать refresh token

GET    /platforms               — список платформ
GET    /accounts                — аккаунты текущего пользователя
POST   /accounts                — создать аккаунт

POST   /proposals               — создать proposal
GET    /proposals               — все proposals (page, limit)
PUT    /proposals/:id           — обновить
DELETE /proposals/:id           — удалить
POST   /proposals/:id/lead      — конвертировать в Lead

GET    /job-posts               — список job-постов из Telegram
POST   /job-posts/:id/convert   — конвертировать job-post в Proposal

GET    /leads                   — все leads (page, limit)
GET    /leads/:id               — lead + proposal
PATCH  /leads/:id               — обновить
DELETE /leads/:id               — удалить
GET    /leads/:id/chat          — история чата

GET    /client-calls            — список звонков
POST   /client-calls            — создать звонок
PATCH  /client-calls/:id        — обновить (статус, notes, transcriptUrl, aiSummary)

GET    /chats                   — все чаты (?type=proposal|lead&cursor=...&limit=20)

POST   /base-knowledge          — добавить запись в базу знаний
GET    /base-knowledge          — список (page, limit)
GET    /base-knowledge/search   — семантический поиск (?q=...)

GET    /prompts                 — список prompt-шаблонов
POST   /prompts                 — создать шаблон
PATCH  /prompts/:id/activate    — активировать шаблон для его типа

GET    /invoices                — список инвойсов
POST   /invoices                — создать инвойс
POST   /invoices/:id/generate   — сгенерировать PDF (invoice-generator.com → B2)
GET    /invoices/:id/pdf        — скачать PDF (подписанный URL B2, 1 час)

GET    /health                  — health check (SELECT 1 к БД)
```

Полная документация: `http://localhost:3000/swagger` (при `NODE_ENV=development`)

---

## WebSocket

Подключение требует `accessToken`:

```js
const socket = io('http://localhost:3001', {
  auth: { token: accessToken }
});

socket.emit('send_message', { proposalId, content });

socket.on('analysis', ({ decision, reasoning }) => { ... }); // сначала
socket.on('chunk',    ({ text }) => { ... });                 // стриминг текста
socket.on('done',     () => { ... });
```

---

## Тесты

```bash
npm run test          # unit
npm run test:e2e      # e2e
npm run test:cov      # coverage
```
