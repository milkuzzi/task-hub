# TaskHub — Система управления задачами

Production-приложение на одном VPS (Docker Compose, без Kubernetes). UI, ошибки
и письма — на русском. БД хранит `timestamptz` в UTC; UI и письма рендерятся в
`Europe/Moscow`.

## Архитектура

- **Бэкенд:** Python 3.12, FastAPI, SQLAlchemy 2.0 async, Alembic, Pydantic v2,
  argon2id, WeasyPrint, httpx (SendPulse REST).
- **Планировщик:** Celery + Celery beat на Redis.
- **Фронтенд:** React + TypeScript + Vite, React Router (lazy routes),
  TanStack Query, RHF + Zod.
- **Инфраструктура:** Nginx (HTTP/2, TLS1.3, CSP+nonce, X-Accel), PostgreSQL 16,
  PgBouncer (transaction pooling), Redis, Certbot.

## Быстрый старт

```bash
cp infra/env.example .env
# заполнить секреты через Docker secrets:
printf '%s' "$PG_PASSWORD"        > secrets/pg_password.txt
printf '%s' "$SENDPULSE_SECRET"   > secrets/sendpulse_secret.txt
printf '%s' "$APP_SECRET"         > secrets/app_secret.txt

cd frontend && npm ci && npm run build && cd ..   # производит pre-сжатые .br/.gz
docker compose up -d --build
docker compose exec backend alembic upgrade head
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='...' \
  docker compose exec -T backend python -m app.workers.seed_admin
```

## Соответствие Zod ↔ Pydantic

| Zod (frontend/src/shared/schemas.ts) | Pydantic (backend/app/schemas) |
|---|---|
| `loginSchema` | `LoginIn` |
| `registerSchema` | `RegisterIn` |
| `taskCreateSchema` | `TaskCreateIn` |
| `taskUpdateSchema` (version required) | `TaskUpdateIn` |
| `statusChangeSchema` | `StatusChangeIn` |
| `completeSchema` | `CompleteIn` |

Zod-схемы — единый источник правды на клиенте; типы и ограничения совпадают с
Pydantic по полям, длинам и enum-значениям статусов.

## Производительность и бюджеты

Целевые бюджеты (референс 4 vCPU / 8 ГБ, 100k задач):
- API p95 ≤ 80 мс на чтениях списков, ≤ 150 мс на мутациях.
- Keyset-страница ≤ 30 мс на стороне БД (index-only scan).
- Фронт: LCP ≤ 1.5с, INP ≤ 200мс, CLS ≤ 0.1; начальный JS ≤ 180 КБ gzip,
  маршрут ≤ 60 КБ.

### Воспроизвести keyset / index-only (EXPLAIN ANALYZE)

Полная стратегия — `backend/app/db/KEYSET.md`. Кратко:

```bash
# 1) засеять 100k задач (скрипт сидинга), затем:
docker compose exec postgres psql -U taskhub -c "VACUUM (ANALYZE) tasks;"
docker compose exec postgres psql -U taskhub -c "
EXPLAIN (ANALYZE, BUFFERS)
SELECT public_no,title,status,is_overdue,version,deadline,id
FROM tasks WHERE deleted_at IS NULL AND owner_id='<uuid>'
  AND (deadline > '2026-06-01' OR (deadline = '2026-06-01' AND id > '<uuid>') OR deadline IS NULL)
ORDER BY deadline ASC NULLS LAST, id ASC LIMIT 50;"
```

Ожидаемо: `Index Only Scan using ix_tasks_owner_deadline`, `Heap Fetches: 0`.

### Нагрузочный тест (k6, 200 VU)

```bash
BASE=https://example.com COOKIE='access_token=...' k6 run tests/k6_load.js
```

Пороги в скрипте: `http_req_duration p(95)<80`, `http_req_failed rate==0`.

### Размеры пулов

Формула и расчёт — `infra/pgbouncer/POOL_SIZING.md`. Кратко: PgBouncer
`DEFAULT_POOL_SIZE=20` (≈2-3×vCPU), app-side `db_pool_size=5` на каждый из 4
gunicorn-воркеров. PgBouncer transaction mode требует asyncpg
`statement_cache_size=0` (см. `backend/app/db/session.py`).

## Безопасность

- HTTPS+HSTS(preload), TLS1.3 (1.2 fallback), редирект HTTP→HTTPS, Certbot.
- CSP строгий с per-request nonce (`map $request_id $cspnonce`), `frame-ancestors
  'none'`, `object-src 'none'`, `base-uri 'self'`; всё хостится локально.
- argon2id (time=3, memory=64MiB, parallelism=2 — калибровать под p95 логина).
- Сессии в Redis: короткий access + refresh с РОТАЦИЕЙ и reuse-detection
  (инвалидация семьи токенов). Cookie httpOnly+Secure+SameSite=Strict.
- CSRF: double-submit (`X-CSRF-Token`) + проверка Origin/Referer.
- Per-task RBAC `resolve_task_role` на каждый запрос; WATCHER enforce в SQL;
  403/404 без утечки существования.
- Загрузки: проверка по magic bytes, лимит размера, запрет исполняемых,
  идемпотентность по (task_id, sha256).
- Rate-limit на /api, усиленный на /login и /register; fail2ban
  (`infra/fail2ban-nginx.local`); ufw (`infra/ufw.rules.sh`) — наружу только
  22/80/443; postgres/redis/pgbouncer — только во внутренней docker-сети.
- Контейнеры: non-root, cap_drop ALL, no-new-privileges, отдельные сети
  front/back. Секреты через Docker secrets, не в открытом env.

## Почта: SPF / DKIM / DMARC

Добавьте DNS-записи для домена отправителя:

```
; SPF
example.com.  TXT  "v=spf1 include:sendpulse.com ~all"
; DKIM (значение выдаёт SendPulse в кабинете)
sp._domainkey.example.com.  TXT  "v=DKIM1; k=rsa; p=<public-key>"
; DMARC
_dmarc.example.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
```

SendPulse OAuth-токен кэшируется в Redis с автообновлением
(`backend/app/services/notifications.py`).

## Бэкапы

`infra/scripts/pg_backup.sh` — ночной `pg_dump` (cron `0 2 * * *`), хранение 14
дней. `infra/scripts/pg_restore_check.sh` — проверяемый restore в throwaway-БД с
ассертом по числу строк.

## Уведомления (4 правила)

День постановки → исполнитель+наблюдатели; за сутки → исполнитель; в день →
исполнитель; после дедлайна → исполнитель ежедневно до «Выполнена». Идемпотентность
через `notifications_log UNIQUE(task_id,user_id,type,target_date)` + INSERT ON
CONFLICT DO NOTHING перед отправкой; отправка только при rowcount=1; ретрай 15 мин
до N попыток. Ночная материализация `is_overdue` в 03:00 MSK.

## Тесты

```bash
python -m pytest tests -q     # RBAC, keyset(NULL+tie-break), magic-bytes, idempotent-notify
```
