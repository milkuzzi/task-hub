import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { resolveErrorMessage } from "@/lib/error-message";
import { MSK_OFFSET_MS } from "@/lib/time";
import {
  TASK_STATUSES,
  TASK_STATUS_LABEL_KEYS,
  type TaskStatus,
} from "@/lib/tasks-api";
import {
  computeStatistics,
  downloadBlob,
  exportFileName,
  exportStatistics,
  isValidRange,
  type ExportFormat,
  type Statistics,
  type StatisticsPeriod,
} from "@/lib/statistics-api";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";

/**
 * Панель статистики для Администратора (задача 20.6, Req 17).
 *
 * Отображает количество Задач по Статусам (включая нулевые, Req 17.1), долю
 * просроченных (Req 17.2), среднее время выполнения (Req 17.3), разрезы по
 * Менеджерам/Исполнителям (Req 17.4) и активность Чатов (Req 17.5). Поддержан
 * фильтр по периоду включительно (Req 17.6) с валидацией диапазона: при начале
 * позже конца запрос отклоняется, а ранее отображённая статистика не меняется
 * (Req 17.7). При отсутствии данных показываются нулевые показатели и
 * уведомление (Req 17.8). Доступен экспорт CSV/Excel за текущий период
 * (Req 17.9, 17.10). Текст — на русском (Req 1.1).
 */

/** Преобразует значение `<input type="date">` (`ГГГГ-ММ-ДД`) в границу периода. */
function dateInputToIso(value: string, endOfDay: boolean): string {
  if (value === "") {
    return "";
  }
  // Границы периода включительны и трактуются как настенное время Москвы
  // (MSK = UTC+3), а не UTC: «от» — начало московских суток, «до» — их конец.
  // Иначе выбор дня смещался бы на 3 часа относительно дня, который видит
  // пользователь (Req 17.6).
  const [y, m, d] = value.split("-").map((part) => Number(part));
  const mskWallMs = endOfDay
    ? Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999)
    : Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  return new Date(mskWallMs - MSK_OFFSET_MS).toISOString();
}

function statusTotal(stats: Statistics): number {
  return TASK_STATUSES.reduce(
    (sum, status) => sum + (stats.statusCounts[status] ?? 0),
    0,
  );
}

function percent(value: number, total: number): number {
  return total <= 0 ? 0 : Math.round((value / total) * 100);
}

export function StatisticsPage(): JSX.Element {
  const { t } = useTranslation();

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [stats, setStats] = useState<Statistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /** Текущий период из полей формы (пустые границы → за всё время). */
  const buildPeriod = useCallback((): StatisticsPeriod => {
    return {
      from: dateInputToIso(fromDate, false),
      to: dateInputToIso(toDate, true),
    };
  }, [fromDate, toDate]);

  /**
   * Загружает статистику за период. При некорректном диапазоне (Req 17.7) не
   * обращается к серверу и не меняет ранее отображённую статистику.
   */
  const load = useCallback(
    async (period: StatisticsPeriod): Promise<void> => {
      if (!isValidRange(period)) {
        setError(t("statistics.errors.range"));
        return; // Сохраняем ранее отображённую статистику (Req 17.7).
      }
      setError(null);
      setLoading(true);
      try {
        const result = await computeStatistics(period);
        setStats(result);
      } catch (err) {
        if (err instanceof ApiError && err.status === 422) {
          // Сервер также отклоняет некорректный диапазон (Req 17.7).
          setError(t("statistics.errors.range"));
        } else {
          setError(resolveErrorMessage(err, t, t("errors.generic")));
        }
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // Первичная загрузка статистики за всё время.
  useEffect(() => {
    void load({ from: "", to: "" });
  }, [load]);

  const handleApply = (event: React.FormEvent): void => {
    event.preventDefault();
    setExportError(null);
    void load(buildPeriod());
  };

  const handleReset = (): void => {
    setFromDate("");
    setToDate("");
    setExportError(null);
    void load({ from: "", to: "" });
  };

  /** Экспорт текущего периода в выбранном формате (Req 17.9, 17.10). */
  const handleExport = async (format: ExportFormat): Promise<void> => {
    const period = buildPeriod();
    setError(null);
    if (period.from === "" || period.to === "") {
      setExportError(t("statistics.errors.exportPeriodRequired"));
      return;
    }
    if (!isValidRange(period)) {
      setExportError(t("statistics.errors.range"));
      return;
    }
    setExportError(null);
    setExporting(format);
    try {
      const blob = await exportStatistics(period, format);
      downloadBlob(blob, exportFileName(format));
    } catch (err) {
      // Ошибка формирования файла не меняет отображённую статистику (Req 17.10).
      if (err instanceof ApiError && err.status === 400) {
        setExportError(t("statistics.errors.exportPeriodInvalid"));
      } else {
        setExportError(
          resolveErrorMessage(err, t, t("statistics.errors.export")),
        );
      }
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t("statistics.heading")}</h1>
        </div>
      </div>

      {/* Фильтр по периоду (Req 17.6). */}
      <form
        className="panel panel--compact report-toolbar"
        onSubmit={handleApply}
        aria-label={t("statistics.period.label")}
      >
        <div className="report-toolbar__controls">
          <label className="field report-toolbar__field">
            <input
              type="date"
              className="field__input"
              aria-label={t("statistics.period.from")}
              value={fromDate}
              max={toDate === "" ? undefined : toDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>
          <label className="field report-toolbar__field">
            <input
              type="date"
              className="field__input"
              aria-label={t("statistics.period.to")}
              value={toDate}
              min={fromDate === "" ? undefined : fromDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </label>
          <button className="btn btn--primary btn--sm" type="submit">
            {t("statistics.period.apply")}
          </button>
          <button className="btn btn--sm" type="button" onClick={handleReset}>
            {t("statistics.period.reset")}
          </button>
          <button
            className="btn btn--sm"
            type="button"
            disabled={exporting !== null}
            aria-busy={exporting === "csv"}
            onClick={() => void handleExport("csv")}
          >
            {exporting === "csv"
              ? t("common.loading")
              : t("statistics.export.csv")}
          </button>
          <button
            className="btn btn--sm"
            type="button"
            disabled={exporting !== null}
            aria-busy={exporting === "xlsx"}
            onClick={() => void handleExport("xlsx")}
          >
            {exporting === "xlsx"
              ? t("common.loading")
              : t("statistics.export.xlsx")}
          </button>
        </div>
        {(error !== null || exportError !== null) && (
          <p className="form-error" role="alert">
            {error ?? exportError}
          </p>
        )}
      </form>

      {loading ? (
        <LoadingState label={t("common.loading")} />
      ) : stats === null ? (
        <EmptyState message={t("common.empty")} />
      ) : (
        <>
          {/* Уведомление об отсутствии данных за период (Req 17.8). */}
          {!stats.hasData && (
            <p className="form-success" role="status">
              {t("statistics.noData")}
            </p>
          )}

          {/* Сводные показатели. */}
          <div className="metric-strip">
            <div className="metric-panel">
              <h2 className="metric-panel__title">
                {t("statistics.summary.total")}
              </h2>
              <p className="metric-panel__value">{stats.totalTasks}</p>
            </div>
            <div className="metric-panel">
              <h2 className="metric-panel__title">
                {t("statistics.summary.overdue")}
              </h2>
              <p className="metric-panel__value">
                {stats.overdueCount}{" "}
                <span className="text-muted">
                  ({stats.overduePercent.toFixed(1)}%)
                </span>
              </p>
            </div>
            <div className="metric-panel">
              <h2 className="metric-panel__title">
                {t("statistics.summary.avgCompletion")}
              </h2>
              <p className="metric-panel__value">
                {stats.avgCompletionHours.toFixed(1)}{" "}
                <span className="text-muted">
                  {t("statistics.summary.hours")}
                </span>
              </p>
            </div>
            <div className="metric-panel">
              <h2 className="metric-panel__title">
                {t("statistics.summary.chatMessages")}
              </h2>
              <p className="metric-panel__value">
                {stats.chatActivity.messageCount}
              </p>
            </div>
            <div className="metric-panel">
              <h2 className="metric-panel__title">
                {t("statistics.summary.activeChats")}
              </h2>
              <p className="metric-panel__value">
                {stats.chatActivity.activeChats}
              </p>
            </div>
          </div>

          <div className="report-visuals">
            <section className="panel panel--compact status-donut">
              <div
                className="status-donut__chart"
                style={{
                  background: donutBackground(stats),
                }}
                aria-label={t("statistics.byStatus")}
              />
              <div className="status-donut__legend">
                <h2>{t("statistics.byStatus")}</h2>
                {TASK_STATUSES.map((status: TaskStatus) => {
                  const total = statusTotal(stats);
                  const count = stats.statusCounts[status] ?? 0;
                  return (
                    <p key={status}>
                      <span
                        className={`status-dot status-dot--${status.toLowerCase()}`}
                      />
                      <span>{t(TASK_STATUS_LABEL_KEYS[status])}</span>
                      <strong>{count}</strong>
                      <span className="text-muted">
                        {percent(count, total)}%
                      </span>
                    </p>
                  );
                })}
              </div>
            </section>

            <section className="panel panel--compact participant-bars">
              <h2>{t("statistics.byManager")}</h2>
              <ParticipantBars rows={stats.byManager} />
            </section>

            <section className="panel panel--compact participant-bars">
              <h2>{t("statistics.byExecutor")}</h2>
              <ParticipantBars rows={stats.byExecutor} />
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function donutBackground(stats: Statistics): string {
  const total = Math.max(1, statusTotal(stats));
  let cursor = 0;
  const colors: Record<TaskStatus, string> = {
    IN_PROGRESS: "var(--status-in-progress)",
    WAITING: "var(--status-waiting)",
    DONE: "var(--status-done)",
    NEEDS_ADMIN: "var(--status-needs-admin)",
    CANCELLED: "var(--status-cancelled)",
  };
  const parts = TASK_STATUSES.map((status) => {
    const start = cursor;
    cursor += ((stats.statusCounts[status] ?? 0) / total) * 100;
    return `${colors[status]} ${start}% ${cursor}%`;
  });
  return `conic-gradient(${parts.join(", ")})`;
}

function ParticipantBars({
  rows,
}: {
  rows: Statistics["byManager"];
}): JSX.Element {
  const max = Math.max(1, ...rows.map((row) => row.taskCount));
  if (rows.length === 0) {
    return <p className="text-muted">Нет данных</p>;
  }
  return (
    <div className="participant-bars__list">
      {rows.map((row) => (
        <div className="participant-bar" key={row.userId}>
          <span>{row.name !== "" ? row.name : row.userId}</span>
          <strong>{row.taskCount}</strong>
          <i
            style={{
              inlineSize: `${Math.max(6, (row.taskCount / max) * 100)}%`,
            }}
          />
        </div>
      ))}
    </div>
  );
}
