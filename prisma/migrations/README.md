# Миграции Prisma

## Первичная миграция `*_init`

`migration.sql` для первичной миграции сгенерирован **офлайн** командой

```bash
prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

потому что на момент создания не было доступной БД PostgreSQL (`prisma migrate dev`
требует подключения к серверу). SQL полностью эквивалентен схеме `schema.prisma`
(15 таблиц, 7 перечислений, внешние ключи и индексы).

## Применение на окружении с доступной БД

Задайте `DATABASE_URL` и выполните:

```bash
# Применить существующие миграции (prod/staging)
npm run db:deploy

# Либо в разработке — создать/применить и сгенерировать клиент
npm run db:migrate
```

Prisma Client генерируется командой `npm run db:generate`.
