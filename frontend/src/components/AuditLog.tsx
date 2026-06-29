import { useTranslation } from "react-i18next";
import { EmptyState } from "./EmptyState";
import { LoadingState } from "./LoadingState";
import type { AuditLogEntry } from "@/lib/audit-api";
import { TASK_STATUS_LABEL_KEYS, type TaskStatus } from "@/lib/tasks-api";

/**
 * Журнал изменений Задачи (Req 20.1, 20.2).
 *
 * Отображает все записи Журнала, упорядоченные от новых к старым (Req 20.2):
 * автор изменения, изменённый параметр, прежнее и новое значения и время в MSK
 * (Req 20.1). Доступ к Журналу контролируется сервером (Req 20.3) —
 * отображается только при наличии данных; отказ доступа обрабатывается
 * вызывающим экраном.
 */
export interface AuditLogProps {
  entries: AuditLogEntry[];
  loading: boolean;
  /** Разрешает идентификатор автора в отображаемое имя (best-effort). */
  resolveAuthor: (authorId: string | null) => string;
}

/** Известные машинные имена параметров Задачи для локализованных подписей. */
const FIELD_LABEL_KEYS = {
  title: "audit.fields.title",
  description: "audit.fields.description",
  deadline: "audit.fields.deadline",
  status: "audit.fields.status",
  executors: "audit.fields.executors",
  managers: "audit.fields.managers",
} as const;

type KnownField = keyof typeof FIELD_LABEL_KEYS;

function isKnownField(field: string): field is KnownField {
  return field in FIELD_LABEL_KEYS;
}

function isTaskStatus(value: string): value is TaskStatus {
  return value in TASK_STATUS_LABEL_KEYS;
}

export function AuditLog({
  entries,
  loading,
  resolveAuthor,
}: AuditLogProps): JSX.Element {
  const { t } = useTranslation();

  if (loading) {
    return <LoadingState label={t("common.loading")} />;
  }

  if (entries.length === 0) {
    return <EmptyState message={t("audit.empty")} />;
  }

  /** Локализованная подпись параметра либо его машинное имя. */
  function fieldLabel(field: string): string {
    return isKnownField(field) ? t(FIELD_LABEL_KEYS[field]) : field;
  }

  /** Отображаемое значение: для Статуса — локализованная подпись, иначе как есть. */
  function displayValue(field: string, value: string | null): string {
    if (value === null || value === "") {
      return t("audit.emptyValue");
    }
    if (field === "status" && isTaskStatus(value)) {
      return t(TASK_STATUS_LABEL_KEYS[value]);
    }
    return value;
  }

  const columns = {
    when: t("audit.columns.when"),
    who: t("audit.columns.who"),
    field: t("audit.columns.field"),
    oldValue: t("audit.columns.oldValue"),
    newValue: t("audit.columns.newValue"),
  };

  return (
    <div className="panel audit-panel table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{columns.when}</th>
            <th>{columns.who}</th>
            <th>{columns.field}</th>
            <th>{columns.oldValue}</th>
            <th>{columns.newValue}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td data-label={columns.when}>{entry.changedAtMsk}</td>
              <td data-label={columns.who}>{resolveAuthor(entry.authorId)}</td>
              <td data-label={columns.field}>{fieldLabel(entry.field)}</td>
              <td data-label={columns.oldValue}>
                {displayValue(entry.field, entry.oldValue)}
              </td>
              <td data-label={columns.newValue}>
                {displayValue(entry.field, entry.newValue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
