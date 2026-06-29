#!/usr/bin/env bash
set -euo pipefail

port="${E2E_PORT:-4173}"
base_url="${E2E_BASE_URL:-http://127.0.0.1:${port}}"
grep_pattern="${PLAYWRIGHT_GREP:-}"
preview_pid=""
tmp_dir="$(mktemp -d)"

cleanup() {
  if [[ -n "$preview_pid" ]]; then
    kill "$preview_pid" 2>/dev/null || true
    wait "$preview_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

if [[ -z "${E2E_BASE_URL:-}" ]]; then
  npm run build
  vite_bin=""
  if [[ -x node_modules/.bin/vite ]]; then
    vite_bin="node_modules/.bin/vite"
  elif [[ -x ../node_modules/.bin/vite ]]; then
    vite_bin="../node_modules/.bin/vite"
  else
    echo "Cannot find Vite executable in workspace or root node_modules." >&2
    exit 1
  fi

  "$vite_bin" preview --host 127.0.0.1 --port "$port" --strictPort >"$tmp_dir/preview.log" 2>&1 &
  preview_pid="$!"

  for _ in $(seq 1 60); do
    if curl -fsS "$base_url/" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$preview_pid" 2>/dev/null; then
      echo "Vite preview exited before becoming ready:" >&2
      cat "$tmp_dir/preview.log" >&2
      exit 1
    fi
    sleep 1
  done

  if ! curl -fsS "$base_url/" >/dev/null 2>&1; then
    echo "Timed out waiting for Vite preview at $base_url" >&2
    cat "$tmp_dir/preview.log" >&2
    exit 1
  fi
fi

if [[ -n "$grep_pattern" ]]; then
  E2E_BASE_URL="$base_url" playwright test --grep "$grep_pattern" "$@"
else
  E2E_BASE_URL="$base_url" playwright test "$@"
fi
