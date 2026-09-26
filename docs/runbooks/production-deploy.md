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

## Rollback

Если релиз откатывается:

1. Остановить приложение (`pm2 stop <app-name>`).
2. Восстановить БД из бэкапа §1 (`pg_restore -Fc`) — обязательно на
   отдельной подтверждённой сессии.
3. Откатить код (`git checkout <previous-tag>` на сервере, повторить
   `npm ci && npm run build`).
4. Запустить приложение.

Rollback-миграции через `prisma migrate resolve --rolled-back` —
только когда `migrate deploy` явно оставил миграцию в состоянии
`applied but failed`. Иначе — восстанавливать из бэкапа.

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
