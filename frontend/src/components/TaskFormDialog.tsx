import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { X } from "@phosphor-icons/react";
import { toMskInputValue, fromMskInputValue } from "@/lib/time";
import {
  TASK_BOUNDS,
  type DirectoryUser,
  type TaskDetail,
} from "@/lib/tasks-api";
import { useFocusTrap } from "./useFocusTrap";

/**
 * Модальная форма создания и редактирования Задачи (Req 9.1–9.5, 10.12).
 *
 * - Создание: Название (1–200), Описание (0–5000), Дедлайн, Исполнители (1–100),
 *   Менеджеры (1–100). При ошибке валидации введённые значения сохраняются
 *   (Req 9.3) — поля управляемые, состояние не сбрасывается.
 * - Редактирование: предзаполняется значениями Задачи; смена Статуса здесь не
 *   выполняется (Req 10.12). Изменение состава участников отправляется отдельно
 *   (Req 2.4–2.7) вызывающим кодом.
 *
 * Дедлайн вводится как московское настенное время (Req 1.2) и конвертируется в
 * абсолютный момент (UTC) перед отправкой.
 */

/** Значения формы, передаваемые наверх при сохранении. */
export interface TaskFormValues {
  title: string;
  /** `null` очищает Описание (Req 9.1); строка — заменяет. */
  description: string | null;
  /** Дедлайн в ISO-8601 (UTC). */
  deadline: string;
  executorIds: string[];
  managerIds: string[];
}

export interface TaskFormDialogProps {
  open: boolean;
  /** Визуальная среда: сайт или MAX mini-app. */
  surface?: "site" | "max";
  /** Редактируемая Задача или `null` для создания. */
  task: TaskDetail | null;
  /** Справочник Пользователей для выбора участников (может быть пуст). */
  directory: DirectoryUser[];
  /** Требовать отдельное подтверждение перед сохранением изменений Задачи. */
  confirmBeforeSubmit?: boolean;
  busy?: boolean;
  /** Серверная ошибка операции (Req 9.3) — отображается над формой. */
  serverError?: string | null;
  onSubmit: (values: TaskFormValues) => void;
  onCancel: () => void;
}

/** Разбирает список идентификаторов из строки, разделённой запятыми/пробелами. */
function parseIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

function sameDeadline(a: string, b: string): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

export function TaskFormDialog({
  open,
  surface = "site",
  task,
  directory,
  confirmBeforeSubmit = false,
  busy = false,
  serverError = null,
  onSubmit,
  onCancel,
}: TaskFormDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const isEdit = task !== null;
  const hasDirectory = directory.length > 0;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("");
  const [executorIds, setExecutorIds] = useState<string[]>([]);
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [participantSearch, setParticipantSearch] = useState("");
  // Запасной ручной ввод идентификаторов, если справочник недоступен.
  const [executorRaw, setExecutorRaw] = useState("");
  const [managerRaw, setManagerRaw] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<TaskFormValues | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Захват фокуса, цикл Tab/Shift+Tab, возврат фокуса и закрытие по Escape
  // (Req 11.2–11.5). Во время выполнения операции (`busy`) Escape не закрывает
  // окно — как и закрытие по подложке.
  const handleEscape = useCallback(() => {
    if (!busy) {
      onCancel();
    }
  }, [busy, onCancel]);

  useFocusTrap({
    active: open,
    containerRef: dialogRef,
    onEscape: handleEscape,
  });

  // Синхронизация полей при открытии/смене редактируемой Задачи.
  useEffect(() => {
    if (!open) {
      setPendingConfirmation(null);
      return;
    }
    setFormError(null);
    setPendingConfirmation(null);
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    if (task === null) {
      setDeadline("");
    } else {
      try {
        setDeadline(toMskInputValue(task.deadline));
      } catch {
        setDeadline("");
        setFormError(t("task.form.errors.deadlineInvalid"));
      }
    }
    setExecutorIds(task?.executorIds ?? []);
    setManagerIds(task?.managerIds ?? []);
    setParticipantSearch("");
    setExecutorRaw((task?.executorIds ?? []).join(", "));
    setManagerRaw((task?.managerIds ?? []).join(", "));
  }, [open, task, t]);

  const directoryOptions = useMemo(
    () => [...directory].sort((a, b) => a.name.localeCompare(b.name, "ru")),
    [directory],
  );
  const assignableDirectoryOptions = useMemo(
    () => directoryOptions.filter((u) => u.role !== "ADMIN"),
    [directoryOptions],
  );

  const filteredAssignableDirectoryOptions = useMemo(() => {
    const query = participantSearch.trim().toLowerCase();
    if (query === "") {
      return assignableDirectoryOptions;
    }
    return assignableDirectoryOptions.filter((u) =>
      u.name.toLowerCase().includes(query),
    );
  }, [assignableDirectoryOptions, participantSearch]);

  const confirmationChangedLabels = useMemo(() => {
    if (task === null || pendingConfirmation === null) {
      return [];
    }
    const labels: string[] = [];
    if (task.title !== pendingConfirmation.title) {
      labels.push(t("task.fields.title"));
    }
    if ((task.description ?? null) !== pendingConfirmation.description) {
      labels.push(t("task.fields.description"));
    }
    if (!sameDeadline(task.deadline, pendingConfirmation.deadline)) {
      labels.push(t("task.fields.deadline"));
    }
    if (!sameIds(task.executorIds, pendingConfirmation.executorIds)) {
      labels.push(t("task.fields.assignees"));
    }
    if (!sameIds(task.managerIds, pendingConfirmation.managerIds)) {
      labels.push(t("task.fields.managers"));
    }
    return labels;
  }, [pendingConfirmation, task, t]);

  if (!open) {
    return null;
  }

  function toggleId(
    list: string[],
    userId: string,
    checked: boolean,
  ): string[] {
    if (checked) {
      return list.includes(userId) ? list : [...list, userId];
    }
    return list.filter((id) => id !== userId);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setFormError(null);

    const trimmedTitle = title.trim();
    if (
      trimmedTitle.length < TASK_BOUNDS.titleMin ||
      trimmedTitle.length > TASK_BOUNDS.titleMax
    ) {
      setFormError(t("task.form.errors.title"));
      return;
    }
    if (description.length > TASK_BOUNDS.descriptionMax) {
      setFormError(t("task.form.errors.description"));
      return;
    }
    if (deadline === "") {
      setFormError(t("task.form.errors.deadlineRequired"));
      return;
    }
    let deadlineIso: string;
    try {
      deadlineIso = fromMskInputValue(deadline).toISOString();
    } catch {
      setFormError(t("task.form.errors.deadlineInvalid"));
      return;
    }

    const allowedAssigneeIds = new Set(
      assignableDirectoryOptions.map((u) => u.id),
    );
    const executors = hasDirectory
      ? executorIds.filter((id) => allowedAssigneeIds.has(id))
      : parseIds(executorRaw);
    const managers = hasDirectory
      ? managerIds.filter((id) => allowedAssigneeIds.has(id))
      : parseIds(managerRaw);

    if (
      executors.length < TASK_BOUNDS.assigneesMin ||
      executors.length > TASK_BOUNDS.assigneesMax
    ) {
      setFormError(t("task.form.errors.executors"));
      return;
    }
    if (
      managers.length < TASK_BOUNDS.assigneesMin ||
      managers.length > TASK_BOUNDS.assigneesMax
    ) {
      setFormError(t("task.form.errors.managers"));
      return;
    }

    const values: TaskFormValues = {
      title: trimmedTitle,
      description: description === "" ? null : description,
      deadline: deadlineIso,
      executorIds: executors,
      managerIds: managers,
    };

    if (isEdit && confirmBeforeSubmit) {
      setPendingConfirmation(values);
      return;
    }

    onSubmit(values);
  }

  const heading =
    pendingConfirmation !== null
      ? t("task.form.confirmEditHeading")
      : isEdit
        ? t("task.form.editHeading")
        : t("task.form.createHeading");
  const surfaceClass =
    surface === "max" ? "task-form-dialog--max" : "task-form-dialog--site";
  const overlayClass = `modal-overlay modal-overlay--task-form modal-overlay--task-form-${surface}`;

  return (
    <div
      className={overlayClass}
      role="presentation"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={`modal task-form-dialog ${surfaceClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-form-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2 className="modal__title" id="task-form-dialog-title">
            {heading}
          </h2>
          <button
            className="btn btn--sm modal__close"
            type="button"
            aria-label={t("common.close")}
            onClick={onCancel}
            disabled={busy}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {pendingConfirmation !== null ? (
          <div className="task-form-dialog__content">
            <div className="modal__body stack">
              {serverError !== null && (
                <p className="form-error" role="alert">
                  {serverError}
                </p>
              )}
              <p className="text-muted">{t("task.form.confirmEditPrompt")}</p>
              <div className="confirm-summary">
                <strong>{t("task.form.confirmEditSummary")}</strong>
                {confirmationChangedLabels.length > 0 ? (
                  <ul>
                    {confirmationChangedLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("task.form.confirmEditNoChanges")}</p>
                )}
              </div>
            </div>
            <div className="modal__actions">
              <button
                className="btn"
                type="button"
                onClick={() => setPendingConfirmation(null)}
                disabled={busy}
              >
                {t("common.back")}
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => {
                  if (pendingConfirmation !== null) {
                    onSubmit(pendingConfirmation);
                  }
                }}
                disabled={busy}
              >
                {busy ? t("common.saving") : t("task.form.confirmEditAction")}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="task-form-dialog__form"
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="modal__body stack">
              {(formError !== null || serverError !== null) && (
                <p className="form-error" role="alert">
                  {formError ?? serverError}
                </p>
              )}

              <div className="task-form-dialog__grid">
                <label className="field task-form-dialog__field task-form-dialog__field--title">
                  <span className="field__label">{t("task.fields.title")}</span>
                  <input
                    className="field__input"
                    type="text"
                    maxLength={TASK_BOUNDS.titleMax}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={busy}
                    required
                  />
                </label>

                <label className="field task-form-dialog__field task-form-dialog__field--deadline">
                  <span className="field__label">{t("task.fields.deadline")}</span>
                  <input
                    className="field__input"
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    disabled={busy}
                    required
                  />
                  <span className="field__hint">
                    {t("task.form.deadlineHint")}
                  </span>
                </label>

                <label className="field task-form-dialog__field task-form-dialog__field--description">
                  <span className="field__label">
                    {t("task.fields.description")}
                  </span>
                  <textarea
                    className="field__input"
                    rows={4}
                    maxLength={TASK_BOUNDS.descriptionMax}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>

              {hasDirectory ? (
                <section className="participant-picker task-form-dialog__participants">
                  <input
                    className="field__input participant-picker__search"
                    type="search"
                    placeholder={t("task.form.participantSearch")}
                    aria-label={t("task.form.participantSearch")}
                    value={participantSearch}
                    onChange={(e) => setParticipantSearch(e.target.value)}
                    disabled={busy}
                  />
                  <div className="participant-picker__columns">
                    <fieldset className="participant-picker__group">
                      <legend>{t("task.fields.assignees")}</legend>
                      <div className="participant-picker__list">
                        {filteredAssignableDirectoryOptions.map((u) => (
                          <label
                            className="participant-option"
                            key={`executor-${u.id}`}
                          >
                            <input
                              type="checkbox"
                              checked={executorIds.includes(u.id)}
                              disabled={busy}
                              onChange={(e) =>
                                setExecutorIds((prev) =>
                                  toggleId(prev, u.id, e.target.checked),
                                )
                              }
                            />
                            <span>
                              {u.name}
                              <small>{t(`profile.roles.${u.role}`)}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="participant-picker__group">
                      <legend>{t("task.fields.managers")}</legend>
                      <div className="participant-picker__list">
                        {filteredAssignableDirectoryOptions.map((u) => (
                          <label
                            className="participant-option"
                            key={`manager-${u.id}`}
                          >
                            <input
                              type="checkbox"
                              checked={managerIds.includes(u.id)}
                              disabled={busy}
                              onChange={(e) =>
                                setManagerIds((prev) =>
                                  toggleId(prev, u.id, e.target.checked),
                                )
                              }
                            />
                            <span>
                              {u.name}
                              <small>{t(`profile.roles.${u.role}`)}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                </section>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">
                      {t("task.fields.assignees")}
                    </span>
                    <input
                      className="field__input"
                      type="text"
                      value={executorRaw}
                      onChange={(e) => setExecutorRaw(e.target.value)}
                      disabled={busy}
                    />
                    <span className="field__hint">{t("task.form.idsHint")}</span>
                  </label>

                  <label className="field">
                    <span className="field__label">
                      {t("task.fields.managers")}
                    </span>
                    <input
                      className="field__input"
                      type="text"
                      value={managerRaw}
                      onChange={(e) => setManagerRaw(e.target.value)}
                      disabled={busy}
                    />
                    <span className="field__hint">{t("task.form.idsHint")}</span>
                  </label>
                </>
              )}
            </div>

            <div className="modal__actions">
              <button
                className="btn"
                type="button"
                onClick={onCancel}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn btn--primary"
                type="submit"
                disabled={busy}
              >
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
