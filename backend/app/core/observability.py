"""Observability: structured JSON logging, latency metrics, Sentry, 5xx alert hook.

- JSON logs with request-id (read from request.state, propagated via X-Request-Id).
- Prometheus-style latency histogram per endpoint, exposed at /api/metrics.
- Sentry init (no-op when SENTRY_DSN unset).
- 5xx / failed-notification counters with a threshold alert hook that emits a
  structured CRITICAL log line (scrape target for Alertmanager/Loki alert rules).
"""
from __future__ import annotations

import json
import logging
import sys
import time
from collections import defaultdict

from app.core.config import settings


def setup_logging() -> None:
    """Root logger emits one JSON object per line."""
    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:
            payload = {
                "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
                "level": record.levelname,
                "logger": record.name,
                "msg": record.getMessage(),
            }
            for k in ("request_id", "method", "path", "status", "duration_ms"):
                v = getattr(record, k, None)
                if v is not None:
                    payload[k] = v
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            return json.dumps(payload, ensure_ascii=False)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level.upper())


def init_sentry() -> bool:
    """Initialize Sentry if a DSN is configured. Returns True when active."""
    if not settings.sentry_dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        sentry_sdk.init(
            dsn=settings.sentry_dsn,
            environment=settings.environment,
            traces_sample_rate=0.1,
            integrations=[StarletteIntegration(), FastApiIntegration()],
        )
        return True
    except Exception:  # pragma: no cover - optional dependency
        logging.getLogger("observability").warning("sentry init failed")
        return False


# --- in-process metrics (Prometheus text exposition) ------------------------
_BUCKETS = (0.01, 0.025, 0.05, 0.08, 0.1, 0.15, 0.2, 0.5, 1.0, 2.5)
_latency_buckets: dict[str, list[int]] = defaultdict(lambda: [0] * (len(_BUCKETS) + 1))
_latency_sum: dict[str, float] = defaultdict(float)
_latency_count: dict[str, int] = defaultdict(int)
_status_counter: dict[str, int] = defaultdict(int)
_alert_counters: dict[str, int] = defaultdict(int)

# Alert thresholds (per process lifetime; reset on restart). Real alerting is
# done by Alertmanager/Loki on the CRITICAL log lines + /api/metrics scrape.
ALERT_5XX_THRESHOLD = 50
ALERT_FAILED_NOTIFY_THRESHOLD = 20


def observe_request(endpoint: str, status_code: int, duration_s: float) -> None:
    _latency_sum[endpoint] += duration_s
    _latency_count[endpoint] += 1
    placed = False
    for i, b in enumerate(_BUCKETS):
        if duration_s <= b:
            _latency_buckets[endpoint][i] += 1
            placed = True
            break
    if not placed:
        _latency_buckets[endpoint][-1] += 1
    _status_counter[str(status_code)] += 1
    if status_code >= 500:
        _alert_counters["http_5xx"] += 1
        _maybe_alert("http_5xx", _alert_counters["http_5xx"], ALERT_5XX_THRESHOLD)


def record_failed_notification() -> None:
    _alert_counters["failed_notifications"] += 1
    _maybe_alert("failed_notifications", _alert_counters["failed_notifications"],
                 ALERT_FAILED_NOTIFY_THRESHOLD)


def _maybe_alert(name: str, value: int, threshold: int) -> None:
    if value and value % threshold == 0:
        logging.getLogger("alert").critical(
            "ALERT threshold breached", extra={"path": name, "status": value}
        )


def render_metrics() -> str:
    lines: list[str] = []
    lines.append("# TYPE http_request_duration_seconds histogram")
    for ep, buckets in _latency_buckets.items():
        cumulative = 0
        for i, b in enumerate(_BUCKETS):
            cumulative += buckets[i]
            lines.append(
                f'http_request_duration_seconds_bucket{{endpoint="{ep}",le="{b}"}} {cumulative}'
            )
        cumulative += buckets[-1]
        lines.append(
            f'http_request_duration_seconds_bucket{{endpoint="{ep}",le="+Inf"}} {cumulative}'
        )
        lines.append(f'http_request_duration_seconds_sum{{endpoint="{ep}"}} {_latency_sum[ep]:.6f}')
        lines.append(f'http_request_duration_seconds_count{{endpoint="{ep}"}} {_latency_count[ep]}')
    lines.append("# TYPE http_responses_total counter")
    for code, n in _status_counter.items():
        lines.append(f'http_responses_total{{code="{code}"}} {n}')
    lines.append("# TYPE app_alert_events_total counter")
    for name, n in _alert_counters.items():
        lines.append(f'app_alert_events_total{{kind="{name}"}} {n}')
    return "\n".join(lines) + "\n"
