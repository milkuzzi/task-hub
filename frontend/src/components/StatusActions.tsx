import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/lib/api";
import { TASK_STATUS_LABEL_KEYS, type TaskStatus } from "@/lib/tasks-api";
import {
  availableStatusActions,
  changeStatus,
  type Actor,
  type StatusAction,
} from "@/lib/status-api";

/**
 * Панель действий смены Статуса Задачи по правилам конечного автомата (Req 10).
 *
 * Отображаются только действия, допустимые из текущего Статуса для роли
 * Пользователя в контексте Задачи (Req 10.4–10.10): расчёт делегирован
 * {@link availableStatusActions}, зеркалящему серверный `StatusMachine`. Сервер
 * остаётся авторитетным: при отказе (`NO_PERMISSION`/`INVALID_TRANSITION`,
 * Req 10.14, 10.15) Статус не меняется, а ошибка показывается Пользователю.
 *
 * Исполнитель не имеет действий смены Статуса (панель не отображается). Время и
 * подписи — на русском (Req 1.1).
 */

interface StatusActionsProps {
  /** Идентификатор Задачи. */
  taskId: string;
  /** Текущий Статус Задачи. */
  status: TaskStatus;
  /** Роль действующего лица в контексте Задачи (`null` — действий нет). */
  actor: Actor | null;
  /** Признак проверки Администратором (Req 10.10). */
  reviewedFlag?: boolean;
  /** Колбэк после успешной смены Статуса (актуальная Задача → новый Статус). */
  onChanged: (status: TaskStatus) => void;
}

/** Ключ перевода подписи действия (без `ADMIN_SET`, у которого свой шаблон). */
const ACTION_LABEL_KEYS = {
  COMPLETE: "task.statusActions.complete",
  START_WORK: "task.statusActions.startWork",
  REOPEN: "task.statusActions.reopen",
  CANCEL: "task.statusActions.cancel",
  RETURN: "task.statusActions.return",
  REQUEST_ADMIN: "task.statusActions.requestAdmin",
  CLEAR_ADMIN: "task.statusActions.clearAdmin",
} as const;

const STATUS_ORDER: readonly TaskStatus[] = [
  "IN_PROGRESS",
  "WAITING",
  "DONE",
  "NEEDS_ADMIN",
  "CANCELLED",
];

interface StatusChoice {
  target: TaskStatus;
  action: StatusAction;
}

/** Стабильный ключ действия для React-списка и состояния «в процессе». */
function actionKey(action: StatusAction): string {
  return action.type === "ADMIN_SET"
    ? `ADMIN_SET:${action.target}`
    : action.type;
}

function targetForAction(
  current: TaskStatus,
  action: StatusAction,
  reviewedFlag: boolean,
): TaskStatus | null {
  switch (action.type) {
    case "COMPLETE":
      return current === "IN_PROGRESS" || current === "WAITING" ? "DONE" : null;
    case "START_WORK":
      return current === "WAITING" ? "IN_PROGRESS" : null;
    case "REOPEN":
      return current === "DONE" ? "IN_PROGRESS" : null;
    case "CANCEL":
      return current === "IN_PROGRESS" ||
        current === "WAITING" ||
        current === "DONE" ||
        current === "NEEDS_ADMIN"
        ? "CANCELLED"
        : null;
    case "RETURN":
      return current === "CANCELLED" ? "IN_PROGRESS" : null;
    case "REQUEST_ADMIN":
      return current === "IN_PROGRESS" || current === "WAITING"
        ? "NEEDS_ADMIN"
        : null;
    case "ADMIN_SET":
      return current === "NEEDS_ADMIN" ? action.target : null;
    case "CLEAR_ADMIN":
      return current === "NEEDS_ADMIN" && !reviewedFlag ? "IN_PROGRESS" : null;
    default:
      return null;
  }
}

function toStatusChoices(
  current: TaskStatus,
  actions: StatusAction[],
  reviewedFlag: boolean,
): StatusChoice[] {
  const byTarget = new Map<TaskStatus, StatusChoice>();
  for (const action of actions) {
    const target = targetForAction(current, action, reviewedFlag);
    if (target === null) {
      continue;
    }
    const existing = byTarget.get(target);
    if (existing === undefined || action.type === "ADMIN_SET") {
      byTarget.set(target, { target, action });
    }
  }
  return [...byTarget.values()].sort(
    (a, b) => STATUS_ORDER.indexOf(a.target) - STATUS_ORDER.indexOf(b.target),
  );
}

export function StatusActions({
  taskId,
  status,
  actor,
  reviewedFlag = false,
  onChanged,
}: StatusActionsProps): JSX.Element | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<TaskStatus | "">("");

  const actions = useMemo<StatusAction[]>(() => {
    if (actor === null) {
      return [];
    }
    return availableStatusActions(status, actor, reviewedFlag);
  }, [actor, status, reviewedFlag]);

  const usesStatusSelect = actor === "ADMIN" || actor === "MANAGER";

  const statusChoices = useMemo(
    () =>
      usesStatusSelect ? toStatusChoices(status, actions, reviewedFlag) : [],
    [actions, reviewedFlag, status, usesStatusSelect],
  );
  const hasStatusSelect = statusChoices.length > 0;

  const buttonActions = useMemo(
    () =>
      usesStatusSelect
        ? []
        : actions.filter((action) => action.type !== "ADMIN_SET"),
    [actions, usesStatusSelect],
  );

  useEffect(() => {
    setSelectedTarget((current) => {
      if (statusChoices.some((choice) => choice.target === current)) {
        return current;
      }
      return statusChoices[0]?.target ?? "";
    });
  }, [statusChoices]);

  if (actor === null || actions.length === 0) {
    return null;
  }

  const labelFor = (action: StatusAction): string => {
    if (action.type === "ADMIN_SET") {
      return t("task.statusActions.adminSet", {
        status: t(TASK_STATUS_LABEL_KEYS[action.target]),
      });
    }
    return t(ACTION_LABEL_KEYS[action.type]);
  };

  const handle = async (action: StatusAction): Promise<void> => {
    setError(null);
    setPending(actionKey(action));
    try {
      const updated = await changeStatus(taskId, action);
      onChanged(updated.status);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : t("task.statusActions.error"),
      );
    } finally {
      setPending(null);
    }
  };

  const handleSelectedStatus = async (): Promise<void> => {
    if (selectedTarget === "") {
      return;
    }
    const selected = statusChoices.find(
      (choice) => choice.target === selectedTarget,
    );
    if (selected === undefined) {
      return;
    }
    await handle(selected.action);
  };

  return (
    <section className="status-strip" aria-label={t("task.fields.status")}>
      <div
        className={
          hasStatusSelect
            ? "status-strip__controls status-strip__controls--with-select"
            : "status-strip__controls"
        }
      >
        {hasStatusSelect && (
          <div className="status-strip__admin-select">
            <select
              className="field__input status-strip__select"
              value={selectedTarget}
              disabled={pending !== null}
              aria-label={t("task.statusActions.adminSelectLabel")}
              onChange={(event) =>
                setSelectedTarget(event.target.value as TaskStatus)
              }
            >
              <option value="" disabled>
                {t("task.statusActions.adminSelectPlaceholder")}
              </option>
              {statusChoices.map((choice) => (
                <option
                  key={`${choice.target}:${actionKey(choice.action)}`}
                  value={choice.target}
                >
                  {t(TASK_STATUS_LABEL_KEYS[choice.target])}
                </option>
              ))}
            </select>
            {(() => {
              const selected = statusChoices.find(
                (choice) => choice.target === selectedTarget,
              );
              const key =
                selected === undefined ? null : actionKey(selected.action);
              return (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={pending !== null || selected === undefined}
                  aria-busy={key !== null && pending === key}
                  onClick={() => void handleSelectedStatus()}
                >
                  {key !== null && pending === key
                    ? t("common.saving")
                    : t("task.statusActions.adminApply")}
                </button>
              );
            })()}
          </div>
        )}
        {buttonActions.length > 0 && (
          <div className="status-strip__buttons">
            {buttonActions.map((action) => {
              const key = actionKey(action);
              return (
                <button
                  key={key}
                  type="button"
                  className="btn btn--sm"
                  disabled={pending !== null}
                  aria-busy={pending === key}
                  onClick={() => void handle(action)}
                >
                  {pending === key ? t("common.saving") : labelFor(action)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
