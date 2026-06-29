import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/use-auth";
import { ApiError } from "@/lib/api";
import { TaskCard } from "@/components/TaskCard";
import {
  TaskFormDialog,
  type TaskFormValues,
} from "@/components/TaskFormDialog";
import { NotificationsPopover } from "@/components/NotificationsPopover";
import { LoadingState } from "@/components/LoadingState";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ChatEvents, connectSocket } from "@/lib/socket";
import { useAppPath, useIsMaxApp } from "@/lib/app-path";
import {
  createTask,
  DEFAULT_TASK_SORT,
  listDirectory,
  listTasks,
  PAGINATION,
  SEARCH_TEXT_BOUNDS,
  type CreateTaskDto,
  type DirectoryUser,
  type PageMeta,
  type TaskAssignmentKind,
  type TaskCard as TaskCardModel,
  type TaskFilters,
  type TaskQuery,
  type TaskSortDirection,
  type TaskSortField,
} from "@/lib/tasks-api";

/**
 * Экран списка Задач (задача 20.4).
 *
 * Объединяет возможности TasksModule и SearchModule:
 * - список видимых Задач карточками с видимостью по роли (Req 2.8–2.10);
 * - счётчик Сообщений 0–9999 и маркер непрочитанного на карточке (Req 9.7–9.9);
 * - подстрочный поиск по Названию/Описанию (1–256, Req 18.1, 18.2);
 * - фильтры по Статусу и роли в Задаче, сортировка до пагинации;
 * - пагинация (по умолчанию 20, максимум 100, Req 18.5, 18.6);
 * - создание Задачи Менеджером/Администратором и редактирование параметров
 *   (Req 9.1–9.5, 10.12).
 *
 * Недопустимые параметры поиска/фильтра отклоняются на клиенте до запроса и не
 * изменяют текущий список (Req 18.2, 18.7).
 */

/** Пустое состояние метаданных страницы до первой загрузки. */
const EMPTY_META: PageMeta = {
  page: PAGINATION.defaultPage,
  pageSize: PAGINATION.defaultPageSize,
  total: 0,
  totalPages: 0,
  hasNext: false,
  hasPrevious: false,
};

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function TasksPage(): JSX.Element {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const appPath = useAppPath();
  const isMaxApp = useIsMaxApp();
  const canManage = user?.role === "ADMIN" || user?.role === "MANAGER";
  const showPageNotifications = user?.role === "ADMIN";

  // Справочник Пользователей для формы (best-effort: при отсутствии прав — пуст).
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);

  const [searchDraft, setSearchDraft] = useState("");
  const [assignmentKind, setAssignmentKind] = useState<TaskAssignmentKind | "">(
    "",
  );
  const [sortBy, setSortBy] = useState<TaskSortField>(DEFAULT_TASK_SORT.field);
  const [sortDirection, setSortDirection] = useState<TaskSortDirection>(
    DEFAULT_TASK_SORT.direction,
  );
  const [showCancelled, setShowCancelled] = useState(false);
  const debouncedSearch = useDebouncedValue(searchDraft, 400);

  const [appliedText, setAppliedText] = useState<string | undefined>(undefined);
  const [appliedFilters, setAppliedFilters] = useState<TaskFilters>({});
  const [page, setPage] = useState<number>(PAGINATION.defaultPage);

  const [tasks, setTasks] = useState<TaskCardModel[]>([]);
  const [meta, setMeta] = useState<PageMeta>(EMPTY_META);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Ошибка валидации параметров поиска/фильтра (Req 18.2, 18.7). */
  const [queryError, setQueryError] = useState<string | null>(null);

  // Форма создания/редактирования.
  const [formOpen, setFormOpen] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    listDirectory()
      .then(setDirectory)
      .catch(() => setDirectory([]));
  }, []);

  const reload = useCallback(
    async (options: { silent?: boolean } = {}): Promise<void> => {
      if (options.silent !== true) {
        setLoading(true);
      }
      setLoadError(null);
      try {
        const query: TaskQuery = {
          filters: appliedFilters,
          sortBy,
          sortDirection,
          page,
          pageSize: PAGINATION.defaultPageSize,
        };
        if (appliedText !== undefined) {
          query.text = appliedText;
        }
        const result = await listTasks(query);
        setTasks(result.items);
        setMeta(result.meta);
      } catch (err) {
        setLoadError(
          err instanceof ApiError ? err.message : t("errors.generic"),
        );
      } finally {
        if (options.silent !== true) {
          setLoading(false);
        }
      }
    },
    [appliedText, appliedFilters, page, sortBy, sortDirection, t],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const socket = connectSocket();
    const onTaskUpdated = (): void => {
      void reload({ silent: true });
    };

    socket.on(ChatEvents.TaskUpdated, onTaskUpdated);
    return () => {
      socket.off(ChatEvents.TaskUpdated, onTaskUpdated);
    };
  }, [reload]);

  useEffect(() => {
    setQueryError(null);

    const text = debouncedSearch.trim();
    if (
      text !== "" &&
      (text.length < SEARCH_TEXT_BOUNDS.min ||
        text.length > SEARCH_TEXT_BOUNDS.max)
    ) {
      setQueryError(t("task.search.errorLength"));
      return;
    }

    const filters: TaskFilters = {};
    if (assignmentKind !== "") {
      filters.assignmentKind = assignmentKind;
    }
    if (showCancelled) {
      filters.statuses = ["CANCELLED"];
    }

    setAppliedText(text === "" ? undefined : text);
    setAppliedFilters(filters);
    setPage(PAGINATION.defaultPage);
  }, [assignmentKind, debouncedSearch, showCancelled, t]);

  function changeSort(field: TaskSortField): void {
    setSortBy(field);
    setPage(PAGINATION.defaultPage);
  }

  function toggleSortDirection(): void {
    setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    setPage(PAGINATION.defaultPage);
  }

  function sortDirectionLabel(): string {
    if (sortBy === "deadline") {
      return sortDirection === "asc"
        ? t("task.search.directionDeadlineAsc")
        : t("task.search.directionDeadlineDesc");
    }
    if (sortBy === "status") {
      return sortDirection === "asc"
        ? t("task.search.directionStatusAsc")
        : t("task.search.directionStatusDesc");
    }
    return sortDirection === "asc"
      ? t("task.search.directionTitleAsc")
      : t("task.search.directionTitleDesc");
  }

  function openCreate(): void {
    setFormError(null);
    setFormOpen(true);
  }

  function closeForm(): void {
    setFormOpen(false);
    setFormError(null);
  }

  async function handleFormSubmit(values: TaskFormValues): Promise<void> {
    setFormBusy(true);
    setFormError(null);
    try {
      const dto: CreateTaskDto = {
        title: values.title,
        deadline: values.deadline,
        executorIds: values.executorIds,
        managerIds: values.managerIds,
      };
      if (values.description !== null) {
        dto.description = values.description;
      }
      await createTask(dto);
      closeForm();
      await reload();
    } catch (err) {
      // Серверная ошибка валидации — введённые значения сохраняются (Req 9.3).
      setFormError(err instanceof ApiError ? err.message : t("errors.generic"));
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t("nav.tasks")}</h1>
          <p className="page-head__meta">
            {t("task.list.total", { count: meta.total })}
          </p>
        </div>
        <div className="page-head__actions">
          {showPageNotifications && <NotificationsPopover />}
          {canManage && (
            <>
              <button
                className={
                  showCancelled ? "btn btn--sm btn--primary" : "btn btn--sm"
                }
                type="button"
                aria-pressed={showCancelled}
                onClick={() => setShowCancelled((value) => !value)}
              >
                {showCancelled
                  ? t("task.actions.showActive")
                  : t("task.actions.showCancelled")}
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={openCreate}
              >
                {t("task.actions.create")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="panel panel--compact task-filterbar">
        {queryError !== null && (
          <p className="form-error" role="alert">
            {queryError}
          </p>
        )}
        <div
          className={
            user?.role === "ADMIN"
              ? "task-filterbar__controls task-filterbar__controls--admin"
              : "task-filterbar__controls"
          }
        >
          <input
            className="field__input task-filterbar__search"
            type="search"
            placeholder={t("task.search.placeholder")}
            aria-label={t("task.search.placeholder")}
            maxLength={SEARCH_TEXT_BOUNDS.max}
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
          />
          {user?.role !== "ADMIN" && (
            <select
              className="field__input task-filterbar__select"
              aria-label={t("task.search.assignmentKind")}
              value={assignmentKind}
              onChange={(e) =>
                setAssignmentKind(e.target.value as TaskAssignmentKind | "")
              }
            >
              <option value="">{t("task.search.assignmentKindAll")}</option>
              <option value="MANAGER">
                {t("task.search.assignmentKindManager")}
              </option>
              <option value="EXECUTOR">
                {t("task.search.assignmentKindExecutor")}
              </option>
            </select>
          )}
          <select
            className="field__input task-filterbar__select"
            aria-label={t("task.search.sortBy")}
            value={sortBy}
            onChange={(e) => changeSort(e.target.value as TaskSortField)}
          >
            <option value="deadline">{t("task.search.sortDeadline")}</option>
            <option value="status">{t("task.search.sortStatus")}</option>
            <option value="title">{t("task.search.sortTitle")}</option>
          </select>
          <button
            className="btn btn--sm task-filterbar__direction"
            type="button"
            aria-label={t("task.search.toggleDirection", {
              direction: sortDirectionLabel(),
            })}
            onClick={toggleSortDirection}
          >
            {sortDirectionLabel()}
          </button>
        </div>
      </div>

      {/* Результаты. */}
      {loading ? (
        <LoadingState label={t("common.loading")} />
      ) : loadError !== null ? (
        <ErrorState message={loadError} onRetry={reload} />
      ) : tasks.length === 0 ? (
        <EmptyState message={t("task.list.empty")} />
      ) : (
        <div className="task-registry">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onOpen={(id) => navigate(appPath(`/tasks/${id}`))}
            />
          ))}
        </div>
      )}

      {/* Пагинация (Req 18.5, 18.6). */}
      {meta.totalPages > 1 && (
        <nav className="pagination" aria-label={t("task.pagination.label")}>
          <button
            className="btn btn--sm"
            type="button"
            disabled={!meta.hasPrevious}
            onClick={() =>
              setPage((p) => Math.max(PAGINATION.defaultPage, p - 1))
            }
          >
            {t("task.pagination.prev")}
          </button>
          <span className="pagination__status">
            {t("task.pagination.status", {
              page: meta.page,
              pages: meta.totalPages,
            })}
          </span>
          <button
            className="btn btn--sm"
            type="button"
            disabled={!meta.hasNext}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("task.pagination.next")}
          </button>
        </nav>
      )}

      <TaskFormDialog
        open={formOpen}
        surface={isMaxApp ? "max" : "site"}
        task={null}
        directory={directory}
        busy={formBusy}
        serverError={formError}
        onSubmit={(values) => void handleFormSubmit(values)}
        onCancel={closeForm}
      />
    </section>
  );
}
