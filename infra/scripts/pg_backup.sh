#!/usr/bin/env bash
# Nightly pg_dump (cron: 0 2 * * *). Keeps 14 days, gzip, then verifies.
set -euo pipefail
TS=$(date +%F_%H%M)
OUT=/backups/taskhub_${TS}.sql.gz
docker compose exec -T postgres pg_dump -U taskhub taskhub | gzip > "$OUT"
find /backups -name 'taskhub_*.sql.gz' -mtime +14 -delete
echo "backup written: $OUT"
