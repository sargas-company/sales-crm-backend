# Discord Integration — инструкция владельца

Эта инструкция описывает, как настроить и обслуживать Discord-контур
новой CRM. Контур состоит из:

- входящей команды `/report` (slash-команда), сохраняющей отчёт в
  существующий `ProjectReport`;
- исходящих уведомлений, которые отправляет бот (напоминание 18:00,
  digest 19:00, недельный digest по понедельникам в 09:00, 09:00
  birthdays, 09:00 absences, late-report);
- двух профилей — `TEST` и `PRODUCTION` — которые редактируются из
  Settings страницы и переключаются одним Owner-кликом.

Все действия ниже выполняются Owner-ом (permission
`discord_integration:*`). Админ-менеджер и Regular Manager не видят
этот раздел.

## 1. Создать Discord Application и Bot

1. Открыть <https://discord.com/developers/applications> → **New
   Application** → имя, напр. `Sargas CRM TEST`.
2. Вкладка **Bot**:
   - Add Bot.
   - Снять `Public Bot` (бот — внутренний).
   - Включить `Message Content Intent` (нужен для будущих расширений,
     безопасно).
3. Записать (без публикации):
   - **Application ID** (General Information) — пойдёт в
     `DISCORD_APP_ID`.
   - **Public Key** (General Information) — пойдёт в
     `DISCORD_PUBLIC_KEY`.
   - **Bot Token** (Bot → Reset Token → копировать один раз) — пойдёт
     в `DISCORD_BOT_TOKEN`. Токен нельзя будет посмотреть повторно,
     поэтому сразу вставьте его в `.env` prod/dev сервера.

## 2. Permissions и установка на сервер

Боту достаточно:

- `View Channels`;
- `Send Messages`;
- `Use Slash Commands`;
- `Embed Links`;
- `Mention Everyone` (нужно только для сообщения о дне рождения;
  можно убрать, если @everyone нежелателен);
- `Read Message History` (для диагностики).

Шаги:

1. Вкладка **OAuth2 → URL Generator** → отметить scope `bot` и
   `applications.commands`.
2. В **Bot Permissions** отметить права из списка выше. Discord выдаст
   invite-URL.
3. Открыть этот URL под аккаунтом, у которого есть **Manage Server** на
   тестовом сервере → **Authorize** → выбрать нужный server (guild).

## 3. Собрать Guild/Channel/Role IDs

В клиенте Discord включить Developer Mode (**Settings → Advanced →
Developer Mode**). Теперь правый клик на любой сервер/канал/роль →
**Copy ID**.

Собрать и сохранить (сохраняются в Settings → Discord Integration,
НЕ в `.env`):

- `guildId` — ID сервера.
- `pmsChannelId` — канал PMS (куда уходят reminder 18:00, digest 19:00,
  weekly digest, absences, late-report).
- `generalChannelId` — канал для birthday-сообщений.
- `opsChannelId` — канал для технических алертов (optional, если
  пусто — технические ошибки идут только в Sentry/логи).
- `managerRoleId` — роль, которую пингует напоминание 18:00.

## 4. Заполнить `.env` сервера

В `/Users/developer/www/sargas/sales-crm/sales-crm-backend/.env`
(или production .env) задать:

```
DISCORD_APP_ID=<Application ID>
DISCORD_PUBLIC_KEY=<Public Key>
DISCORD_BOT_TOKEN=<Bot Token>
```

`guildId` **не секрет** и в env не хранится — задаётся на TEST и
PRODUCTION профилях (Settings → Discord Integration).

`.env` уже в `.gitignore`. Никогда не коммитить и не вставлять
значения в документацию, slack или issue tracker.

Перезагрузка приложения требуется **только** при смене переменных
окружения. Channel/role IDs и расписания в Settings применяются сразу.

## 5. Поднять HTTPS tunnel для dev

Discord требует публичный HTTPS endpoint для interactions URL.
Локально проще всего через Cloudflare Tunnel или ngrok:

```
cloudflared tunnel --url http://localhost:3000
# или
ngrok http 3000
```

Запомнить выданный URL, например
`https://zippy-herring.trycloudflare.com`.

В Discord Developer Portal → General Information → **Interactions
Endpoint URL** указать:

```
https://<tunnel>/webhooks/discord/interactions
```

Discord сразу пришлёт PING; endpoint должен ответить 200 с
`type: 1`. При сохранении URL в Portal увидите "Verified!" — наш
`VerifyDiscordSignature` отработал. Если видите "URL not valid":
проверьте, что `DISCORD_PUBLIC_KEY` в `.env` соответствует именно
этому приложению и что сервер перезапущен после правки `.env`.

## 6. Зарегистрировать `/report` в тестовом сервере

```
cd sales-crm-backend
# default: TEST профиль
npx ts-node scripts/register-discord-commands.ts
# или явно:
npx ts-node scripts/register-discord-commands.ts --profile=PRODUCTION
npx ts-node scripts/register-discord-commands.ts --guild=<guild id>
```

CLI читает `guildId` из активной записи `DiscordProfile`. Перед
запуском заполнить profile TEST (или передать `--guild=` явно).

Guild-scoped регистрация появляется в Discord почти мгновенно. Для
глобальной (которая может занять до часа) есть флаг `--global`, но
для drill не рекомендуется.

Успех: STDOUT печатает `{ok: true, scope: "guild <id>", name: "report", id: "..."}`.

## 7. Заполнить TEST профиль в UI

Settings → **Discord Integration** (Owner-only) → профиль **TEST** →
вставить `guildId`, `pmsChannelId`, `generalChannelId`, `opsChannelId`,
`managerRoleId`, при необходимости поменять `cutoffHour`, `reminderAt`,
`dailyDigestAt`, `timezone` (по умолчанию `Europe/Kyiv`). Save.

## 8. Связать проект с каналом Discord

Projects → открыть проект → **Edit** → поле **Discord channel ID**
→ вставить ID канала (snowflake). Save. Один канал ↔ один Project.
Валидация: 17-20 цифр, уникальность — на уровне БД.

## 9. Привязать Employee → Discord user

Employees → открыть сотрудника → **Edit** → поле **Discord user ID**
→ вставить его Discord user ID. Также заполнить **Date of birth**, если
нужны поздравления. Save.

## 10. Тестовые действия

Settings → Discord Integration → для TEST профиля:

- **Verify access** — делает `GET /channels/:id` на каждый канал. Увидите
  Configured/Incomplete + последний status.
- **Send test** — шлёт помеченное `[TEST]` сообщение в PMS channel.
- **Send preview** — на каждый тип уведомления (birthday / absences /
  reminder / daily digest / weekly digest / late report) — публикует
  образец в соответствующий channel. Preview **не** создаёт
  `ProjectReport` и **не** резервирует production idempotency-ключи.

Для реальной проверки `/report`:

1. Зайти в канал, привязанный к проекту.
2. Набрать `/report hours:4 text:сделал X`.
3. Ожидаемая реакция: публичный embed в канале «📋 Daily report —
   <project>». Строка `BackupRun`-row в БД + `ProjectReport` row.
4. Повторный `/report` в тот же день → ephemeral `ℹ️ A report for ...
   today already exists`.

Проверить запись: Projects → <project> → Reports; или в БД:
```sql
SELECT * FROM "ProjectReport" ORDER BY "createdAt" DESC LIMIT 5;
```

## 11. Диагностика

- **401 "invalid request signature"**: `DISCORD_PUBLIC_KEY` не
  соответствует приложению, либо сервер не перезапущен после правки
  `.env`.
- **ephemeral "This channel is not linked to a project"**: не
  заполнен `Project.discordChannelId` для этого канала.
- **ephemeral "Your Discord account is not linked to an Employee"**:
  у Employee пустое `discordUserId`.
- **ephemeral "A report for ... today already exists"**: сработал
  per-project-per-day инвариант. Если нужно изменить отчёт — через
  CRM-страницу `/projects/<id>/reports`.
- **429 от Discord**: scheduler распознаёт `Retry-After` и повторяет
  в следующем тике; на одном тике максимум 1 попытка.
- **Missing permissions (50001/50013)**: boт не в канале или нет
  Send Messages. Пригласить/проверить роли.

## 12. Переключение TEST → PRODUCTION

1. Создать второе Discord Application для prod (не переиспользовать
   test). Повторить шаги 1-6 для production guild.
2. Положить **prod**-значения `DISCORD_APP_ID` / `_PUBLIC_KEY` /
   `_BOT_TOKEN` в prod `.env`. Перезапустить API.
3. Открыть Settings → Discord Integration → заполнить профиль
   **PRODUCTION** (guild / channel / role IDs).
4. Нажать **Activate** на профиле `PRODUCTION`. Modal confirmation +
   запись в Audit Log. Автоматически деактивирует `TEST`.

Проверить: Settings page → `Active profile` = PRODUCTION,
`last successful delivery` обновляется после очередного тика.

## 13. Откат

Если prod-профиль сломался — Settings → Discord Integration →
Activate `TEST`. Один клик, modal confirmation, никакого restart.
После этого prod-канал молчит до следующей активации PRODUCTION.

## 14. Ротация Bot Token

1. Developer Portal → приложение → Bot → **Reset Token**. Старый
   токен сразу перестаёт работать.
2. Заменить `DISCORD_BOT_TOKEN` в соответствующем `.env`.
3. Перезапустить API (это единственное действие, требующее restart).

## 15. Что применяется сразу / что требует restart

**Применяется сразу (без restart):**
- любая правка channel/role IDs в Settings;
- включение/выключение notification типа (reportsEnabled, …);
- смена cutoffHour, reminderAt, dailyDigestAt, …;
- смена активного профиля (TEST ⇄ PRODUCTION).

**Требует restart API:**
- смена `DISCORD_APP_ID` / `DISCORD_PUBLIC_KEY` / `DISCORD_BOT_TOKEN`
  в `.env`.

## 16. Чего категорически нельзя публиковать

- `DISCORD_BOT_TOKEN` (включая его последние 4 символа) — не копировать
  в чаты, screenshots, issue tracker, commit message, test fixture.
- `DISCORD_PUBLIC_KEY` — не секрет (публичный), но хранить рядом с
  приложением.
- `.env` файл — никогда не коммитить. CI secrets хранить в хранилище
  провайдера.
- Полные Discord webhook URLs — проект больше их не использует для
  публикации, но если у вас остались от старой админки — их тоже не
  коммитить.

## 17. Операционные скрипты

```
# один раз на новом guild (или после смены сигнатуры команды):
npx ts-node scripts/register-discord-commands.ts --guild=<id>

# ручной бэкап, если вдруг нужен манифест:
BACKUP_TYPE=MANUAL npx ts-node scripts/backup.ts

# retention check для backup bucket:
npx ts-node scripts/prune-backups.ts          # dry-run
npx ts-node scripts/prune-backups.ts --apply  # perform
```

Никакие Discord-операции НЕ выполняются автоматически без
активного профиля — создавшая миграция оставляет оба профиля
`active = false` до первой ручной активации.
