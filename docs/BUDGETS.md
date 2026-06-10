# Воспроизведение целевых бюджетов (Definition of Done)

Референс-железо: 4 vCPU / 8 ГБ, БД с 100k задач.

## 1. Сидинг 100k задач

```bash
docker compose exec -T backend env N=100000 python -m app.workers.seed_tasks
docker compose exec -T postgres psql -U taskhub -c "VACUUM (ANALYZE) tasks;"
```

## 2. Keyset / index-only (DB ≤ 30 мс)

```bash
docker compose exec -T postgres psql -U taskhub -f - <<'SQL'
EXPLAIN (ANALYZE, BUFFERS)
SELECT public_no,title,status,is_overdue,version,deadline,id
FROM tasks WHERE deleted_at IS NULL AND owner_id=(SELECT id FROM users LIMIT 1)
  AND (deadline > '2026-06-01' OR (deadline = '2026-06-01' AND id > '00000000-0000-0000-0000-000000000000') OR deadline IS NULL)
ORDER BY deadline ASC NULLS LAST, id ASC LIMIT 50;
SQL
```

Принять, если: `Index Only Scan using ix_tasks_owner_deadline`, `Heap Fetches: 0`,
`Execution Time < 30 ms`. Подробности — `backend/app/db/KEYSET.md`.

## 3. API p95 (≤ 80 мс чтение / ≤ 150 мс мутации) — k6, 200 VU

```bash
BASE=https://example.com COOKIE='access_token=...' k6 run tests/k6_load.js
```

Пороги уже в скрипте: `http_req_duration p(95)<80`, `http_req_failed rate==0`.
Для мутаций — отдельный сценарий с порогом p(95)<150 (добавить scenario в k6).

Латентность также видна в реальном времени на `/api/metrics`
(Prometheus histogram `http_request_duration_seconds`), p95 считается
`histogram_quantile(0.95, ...)` в Prometheus/Grafana.

## 4. Фронт (LCP ≤ 1.5c, INP ≤ 200мс, CLS ≤ 0.1; JS ≤ 180 КБ gzip)

```bash
cd frontend && npm run build
# размеры бандла:
find dist/assets -name '*.js' -exec sh -c 'gzip -c "$1" | wc -c | xargs echo "$1"' _ {} \;
# Lighthouse (throttled 4G / mid-tier):
npx lighthouse https://example.com --preset=desktop --throttling-method=simulate
```

Принять, если начальный JS ≤ 180 КБ gzip, маршрутный чанк ≤ 60 КБ, и
Lighthouse-метрики в пределах бюджета.

## 5. Наблюдаемость

- `/api/health` — БД + Redis.
- `/api/metrics` — латентность по эндпоинтам, счётчики ответов, alert-события.
- Structured JSON-логи с `request_id` (заголовок `X-Request-Id`).
- Sentry активируется через `SENTRY_DSN` (no-op без DSN).
- Алерты: правила Alertmanager/Loki по росту `http_responses_total{code=~"5.."}`
  и `app_alert_events_total{kind="failed_notifications"}`; приложение также
  пишет CRITICAL-строку лога при превышении порога.
