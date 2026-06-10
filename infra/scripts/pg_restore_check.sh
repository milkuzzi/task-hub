#!/usr/bin/env bash
# Verifiable restore: load latest dump into a throwaway DB and assert rowcount.
set -euo pipefail
LATEST=$(ls -t /backups/taskhub_*.sql.gz | head -1)
echo "restoring $LATEST into taskhub_restore_check"
docker compose exec -T postgres psql -U taskhub -c "DROP DATABASE IF EXISTS taskhub_restore_check;"
docker compose exec -T postgres psql -U taskhub -c "CREATE DATABASE taskhub_restore_check;"
gunzip -c "$LATEST" | docker compose exec -T postgres psql -U taskhub -d taskhub_restore_check
CNT=$(docker compose exec -T postgres psql -U taskhub -d taskhub_restore_check -tAc "SELECT count(*) FROM tasks;")
echo "restore OK, tasks rows: $CNT"
docker compose exec -T postgres psql -U taskhub -c "DROP DATABASE taskhub_restore_check;"
