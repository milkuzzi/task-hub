#!/usr/bin/env bash
set -euo pipefail

base_url="${TASKHUB_BASE_URL:-${1:-}}"
api_prefix="${TASKHUB_API_PREFIX:-/api}"
require_backup="${TASKHUB_REQUIRE_BACKUP:-1}"
require_offsite_restic="${TASKHUB_REQUIRE_OFFSITE_RESTIC:-1}"
metrics_token="${TASKHUB_METRICS_TOKEN:-}"

if [[ -z "$base_url" ]]; then
  echo "Usage: TASKHUB_BASE_URL=https://example.com npm run smoke:release" >&2
  exit 2
fi

api_url() {
  printf '%s%s%s' "${base_url%/}" "$api_prefix" "$1"
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

headers="$tmp_dir/headers"
body="$tmp_dir/body"

curl -fsS -D "$headers" -o "$body" "$(api_url /health)" >/dev/null
if grep -iq '^x-powered-by:' "$headers"; then
  echo "FAIL: X-Powered-By header is exposed" >&2
  exit 1
fi
grep -q '"status":"ok"' "$body"

ready_code="$(curl -sS -D "$headers" -o "$body" -w '%{http_code}' "$(api_url /ready)")"
if [[ "$ready_code" != "200" ]]; then
  echo "FAIL: /ready returned HTTP $ready_code" >&2
  cat "$body" >&2
  exit 1
fi
grep -q '"status":"ok"' "$body"

metrics_args=()
if [[ -n "$metrics_token" ]]; then
  metrics_args=(-H "Authorization: Bearer $metrics_token")
fi
metrics="$(curl -fsS "${metrics_args[@]}" "$(api_url /metrics)")"
grep -q '^taskhub_process_uptime_seconds ' <<<"$metrics"

if [[ "$require_backup" == "1" ]]; then
  grep -q '^taskhub_backup_mode_required 1$' <<<"$metrics" || {
    echo "FAIL: backup mode is not required" >&2
    exit 1
  }
fi

if [[ "$require_offsite_restic" == "1" ]]; then
  grep -q '^taskhub_backup_restic_offsite_configured 1$' <<<"$metrics" || {
    echo "FAIL: restic repository is not configured as offsite" >&2
    exit 1
  }
fi

echo "Release smoke passed for ${base_url%/}${api_prefix}"
