# Production deploy runbook

> **`make deploy` и `make backup` являются deprecation-заглушками.**
> Охраняемый (guarded) production-набор команд отложен до отдельной
> feature. Пока такой feature нет, production-развёртывание идёт
> вручную по этой инструкции. Не запускайте `pm2 restart all`,
> `prisma migrate deploy` и т.п. из локальной среды с локальным
> `DATABASE_URL` — гвард `assert-local-db.ts` защищает только
> локальные `make local-*` цели.

Аудитория: оператор с ssh-доступом на production-сервер и правом
запускать Prisma-миграции против production БД.

## Предпосылки перед началом

- [ ] Изменения смёржены в основную ветку и код на сервере — тот же
      HEAD, что и в git-репозитории.
- [ ] Есть свежий backup production БД (см. §1) и он верифицирован
      (файл не пустой; размер соответствует ожиданиям).
- [ ] У оператора есть роли для запуска `npx prisma migrate deploy`
      против production-хоста.
- [ ] Downtime-окно согласовано, если миграция ломающая.

## 1. Backup

`scripts/backup.ts` (`npx ts-node -r tsconfig-paths/register
scripts/backup.ts`) остаётся полностью рабочим — цель `make backup`
только заменена на deprecation-заглушку.

```bash
npx ts-node -r tsconfig-paths/register scripts/backup.ts
```

Что делает:

- Читает `DATABASE_URL` (текущее окружение процесса).
- Запускает `pg_dump -Fc` через `PG_DUMP_BIN` (см. `.env.example`).
- Загружает получившийся `.dump` в B2-бакет `B2_BUCKET_DB_DUMPS_ID`
  под именем `manual/<dd-mm-yyyy>_<hhmm>.dump`.

Перед запуском:

- Убедитесь, что `DATABASE_URL` в окружении оператора действительно
  указывает на production-хост, а не на локальный;
- `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_DB_DUMPS_ID` должны быть
  выставлены.

Verify: файл в бакете, размер сопоставим с предыдущими бэкапами.

## 2. Валидация Prisma-схемы

```bash
npx prisma validate --config=./prisma.config.ts
```

Не касается БД. Должен завершиться `The schema at prisma/schema.prisma is valid`, exit 0.

## 3. Применить миграции

```bash
npx prisma migrate deploy --config=./prisma.config.ts
```

`migrate deploy` только применяет уже существующие миграции —
не создаёт новые и не запускает seed. Прогнать только с валидным
production-бэкапом (см. §1).

Если миграция валится — не пытаться "починить" вживую. Восстановить
из бэкапа и разбираться в staging-контуре.

## 3a. Sales attachments storage (`ATTACHMENTS_DIR`)

Релиз добавляет файловое хранилище для вложений Lead/Client. Код
читает путь из `process.env.ATTACHMENTS_DIR`; если переменная не
задана — fallback `<cwd>/uploads/attachments`.

Перед первым прогоном **этого** релиза:

1. Выбрать персистентный путь на хосте (пример:
   `/var/lib/sargas-crm/attachments`). Он должен пережить
   `npm ci` + rebuild + process restart.
2. Создать каталог и выдать владельца процессу бэкенда:
   ```bash
   sudo mkdir -p /var/lib/sargas-crm/attachments
   sudo chown -R <app-user>:<app-user> /var/lib/sargas-crm/attachments
   ```
3. Добавить `ATTACHMENTS_DIR=/var/lib/sargas-crm/attachments` в
   production `.env`.
4. Если на хосте уже есть файлы из предыдущих ручных прогонов
   (неожиданно, т.к. функция новая): до запуска свежего бэкенда
   перенести их в новый каталог с сохранением относительной
   структуры:
   ```bash
   rsync -a <old-cwd>/uploads/attachments/ /var/lib/sargas-crm/attachments/
   ```
   Прод-файлы на этом шаге НЕ удалять — только копировать.

Эта секция обязательна только при первом релизе, который доставляет
attachments. Последующие миграции хранилище не трогают.

## 4. Prisma client

```bash
npx prisma generate --config=./prisma.config.ts
```

Обновляет клиент под текущий `schema.prisma`. Не касается БД.

## 5. Собрать приложение

```bash
npm ci
npm run build
```

`npm ci` даёт воспроизводимую установку по `package-lock.json`.
`npm run build` пишет в `dist/`. Не запускайте `npm run lint` здесь —
он изменяет исходники.

## 6. Перезапустить сервис

Используйте свой process supervisor (PM2, systemd, docker,
runit — что уже настроено на этом хосте). Не хардкодьте
`pm2 restart all` без явной уверенности, что PM2 действительно
управляет только процессами этого приложения.

Стандартный шаблон при PM2:

```bash
pm2 restart <app-name>   # заменить <app-name> на реальный процесс
pm2 logs <app-name> --lines 100
```

Проверьте:

- `pm2 status` (или аналог) — процесс `online`, нет crash loop;
- Логи первых 60 секунд не содержат `PrismaClientKnownRequestError`
  на старте;
- Health-check ping (`GET /`, если такой есть) отдаёт 200.

## 7. Верификация после релиза

- Один тестовый запрос по критичному пути (например `GET /leads`).
- Swagger доступен только при `NODE_ENV=development`; на проде
  проверять через реальный REST.
- Мониторинг: убедиться, что нет всплеска 5xx / очередей BullMQ.

## Window «старый код против новой схемы»

Между моментом `migrate deploy` и `pm2 restart <app>` на хосте
крутится СТАРАЯ сборка на НОВОЙ схеме. Это окно не равно нулю: оно
занимает примерно столько, сколько `npm ci && npm run build + pm2
restart`. На проекте без hot-reload это обычно десятки секунд, но
может длиться минуты при тяжёлой сборке или health-check gating.

Поэтому порядок шагов намеренный:

- `npm ci` + `npm run build` (§5) выполняется ДО `migrate deploy`,
  чтобы артефакт был готов и `pm2 restart` сократил window до
  времени одного рестарта.
- Миграции в этом релизе — additive-only (новые nullable колонки,
  новые enum values, новая таблица) — старый код продолжает читать
  уже существовавшие колонки без проблем.
- **Исключение**: `20261027000000_drop_gigradar_score` удаляет
  колонку `JobPost.gigRadarScore`. Проверка перед релизом: `git
  grep gigRadarScore` на предыдущем теге, с которого откатывались
  бы. Если старый код колонку читает — старая сборка упадёт после
  миграции И до рестарта. На момент релиза в working tree
  ссылок нет; оператор должен подтвердить то же на `<previous-tag>`
  прежде чем применять миграцию.

## Rollback

Разделяем откат приложения и восстановление данных: смешивать их
опасно, поскольку восстановление БД сотрёт любые записи, появившиеся
после `scripts/backup.ts` из §1.

### A. Откат только приложения (при баге в новой сборке)

Условие: `migrate deploy` отработал без ошибок, но приложение
крашит или даёт функциональный regress.

1. **Перед откатом** проверить совместимость `<previous-tag>` с
   применёнными миграциями:
   - `LeadStatus` теперь содержит значение `CLIENT`. Старый код,
     построенный `prisma generate` до миграции 20261028000000,
     увидит в БД неизвестный enum value при чтении. Prisma
     генерирует TS-enum замороженно под схему тега. Если старый
     код выполняет `switch(status)` без `default`, он может пройти,
     но типизация обманет. **Не ставить тег, который не содержит
     CLIENT в schema.prisma.**
   - `NotificationType` теперь содержит `CALL_SCHEDULED/
     RESCHEDULED/CANCELLED`. То же самое — `<previous-tag>` без
     этих значений, но строка в БД — Prisma кинет decode-error.
   - `JobPost.gigRadarScore` удалена. Если `<previous-tag>`
     читает это поле — упадёт. Проверить
     `git grep gigRadarScore <previous-tag>`.

   Если хоть одна проверка не пройдена — откат кода небезопасен,
   нужен путь B (восстановление БД + кода вместе).

2. `pm2 stop <app-name>`.
3. `git checkout <previous-tag>` → `npm ci && npm run build`.
4. `pm2 start <app-name>`.
5. Логи первых 60 секунд.

**БД не трогается.** Данные, появившиеся после backup'а в §1 (новые
Lead, Client, ClientCall, attachment-файлы), сохраняются.

### B. Восстановление БД (только по явному решению оператора)

Условие: ошибка в миграции И невозможно откатить одним только кодом.

**Внимание**: `pg_restore -Fc` из §1-бэкапа ПЕРЕЗАПИШЕТ все записи,
появившиеся в проде после момента снятия бэкапа. Это может быть
значительным объёмом (новые регистрации, call-ы, уведомления, uploads).
Автоматическое выполнение этого шага ЗАПРЕЩЕНО — только явное
решение оператора после оценки delta.

Шаги:
1. `pm2 stop <app-name>`.
2. Снять дополнительный «ситуационный» бэкап текущего (повреждённого)
   состояния для forensic разбора: `scripts/backup.ts` с суффиксом
   `pre-restore`.
3. Решение: принять потерю delta ⇒ `pg_restore -Fc --clean --if-exists
   -d $PROD_DB <backup-file>`.
4. `git checkout <previous-tag>` → `npm ci && npm run build`.
5. `pm2 start <app-name>`.
6. **Attachment-файлы на диске не восстанавливаются бэкапом БД** —
   проверить, что `ATTACHMENTS_DIR` содержит старые файлы. Если
   файлы удалены между backup и restore — orphan DB-строки (ссылки
   есть, файла нет); эндпоинт `/attachments/:id/download` вернёт
   404 «Attachment file is missing», что приемлемо.

### C. Проваленная миграция (migrate deploy failure)

Prisma оставила миграцию в состоянии `applied but failed`
(`_prisma_migrations.finished_at IS NULL`).

1. **Не запускать повторный `migrate deploy`.** Он не починит.
2. Остановить приложение.
3. Воспроизвести ошибку в staging на свежем restore of backup.
   Подготовить ручной fix-SQL.
4. На проде применить fix-SQL в отдельной сессии; затем `prisma
   migrate resolve --applied <migration-name>` или `--rolled-back
   <migration-name>` в зависимости от результата.
5. Приложение — после разбора.

`prisma migrate resolve --rolled-back` сам по себе данные не
меняет; это только маркер в `_prisma_migrations`.

## Известные ограничения этой инструкции

- Нет автоматического health-check gate — оператор проверяет вручную.
- Нет `--dry-run` для миграций (Prisma не поддерживает).
- Нет автоматической проверки, что `DATABASE_URL` действительно
  production; оператор отвечает за это сам. Guard
  `assert-local-db.ts` защищает только локальный контур.

Охраняемый (guarded) production-набор команд — с проверкой хоста,
подтверждением оператора и `--dry-run`-путём — планируется отдельной
feature. До неё эта инструкция — единственный поддерживаемый способ
production-развёртывания.
