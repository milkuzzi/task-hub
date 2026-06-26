import { api } from './api';
import type { UserRole } from './auth-api';

/**
 * Типы и REST-вызовы Задач «Системы поручений».
 *
 * Контракты соответствуют разделам TasksModule и SearchModule дизайна:
 * - `listTasks(query)` — список видимых Задач с поиском, фильтрами и пагинацией
 *   (`TasksService.listVisible`, Req 2.8–2.10, 18.1–18.7).
 * - `getTask(id)` — детальная Задача с составом участников (Req 2.12).
 * - `createTask(dto)` — создание Задачи Менеджером (Req 9.1–9.5).
 * - `updateTask(id, patch)` — изменение параметров без смены Статуса (Req 10.12).
 * - `assignTask(id, assignment)` — изменение состава участников (Req 2.4–2.7).
 * - `listDirectory()` — справочник Пользователей для выбора участников (best-effort).
 *
 * Время передаётся в ISO-8601 (UTC); клиент отображает его в MSK (Req 1.2).
 */

/** Статус Задачи (значения совпадают с серверным перечислением, Req 10). */
export type TaskStatus = 'IN_PROGRESS' | 'WAITING' | 'DONE' | 'NEEDS_ADMIN' | 'CANCELLED';

/** Полный перечень Статусов для фильтра по Статусу (Req 18.3). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'IN_PROGRESS',
  'WAITING',
  'DONE',
  'NEEDS_ADMIN',
  'CANCELLED',
];

/**
 * Сопоставление Статуса с ключом перевода (Req 1.1).
 *
 * Литеральные ключи позволяют типобезопасно вызывать `t(...)` для Статуса без
 * вычисляемых строк, отвергаемых типизацией i18next.
 */
export const TASK_STATUS_LABEL_KEYS = {
  IN_PROGRESS: 'task.status.in_progress',
  WAITING: 'task.status.waiting',
  DONE: 'task.status.done',
  NEEDS_ADMIN: 'task.status.needs_admin',
  CANCELLED: 'task.status.cancelled',
} as const;

/** Границы параметров Задачи на клиенте (Req 9.1). Дублируют серверные. */
export const TASK_BOUNDS = {
  titleMin: 1,
  titleMax: 200,
  descriptionMax: 5000,
  assigneesMin: 1,
  assigneesMax: 100,
} as const;

/** Границы строки поискового запроса (Req 18.1, 18.2). */
export const SEARCH_TEXT_BOUNDS = { min: 1, max: 256 } as const;

/** Границы и значения по умолчанию пагинации (Req 18.5). */
export const PAGINATION = {
  defaultPage: 1,
  defaultPageSize: 20,
  maxPageSize: 100,
} as const;

/**
 * Карточка Задачи в списке (Req 2.8, 9.7, 9.8).
 *
 * Содержит насыщенный счётчик Сообщений (0–9999, Req 9.7, 9.9) и маркер
 * непрочитанных Сообщений текущим Пользователем (Req 9.8).
 */
export interface TaskCard {
  id: string;
  title: string;
  description: string | null;
  /** Дедлайн (ISO-8601, UTC) — отображается в MSK (Req 1.2). */
  deadline: string;
  status: TaskStatus;
  /** Счётчик Сообщений 0–9999 с насыщением на 9999 (Req 9.7, 9.9). */
  messageCount: number;
  /** Есть ли непрочитанные текущим Пользователем Сообщения (Req 9.8). */
  hasUnread: boolean;
  /** Просрочена ли Задача относительно серверного текущего времени. */
  isOverdue: boolean;
}

/** Детальная Задача с составом участников (Req 2.12, 10.12). */
export interface TaskDetail extends TaskCard {
  executorIds: string[];
  managerIds: string[];
}

/** Метаданные страницы результатов (Req 18.5, 18.6). */
export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/** Универсальная страница результатов (Req 18.5). */
export interface Page<T> {
  items: T[];
  meta: PageMeta;
}

/** Набор фильтров Задач (логическое И, Req 18.3). */
export interface TaskFilters {
  /** Фильтр по Статусу: Задача имеет один из перечисленных Статусов. */
  statuses?: TaskStatus[];
  /** Нижняя граница Дедлайна включительно (ISO-8601, UTC). */
  deadlineFrom?: string;
  /** Верхняя граница Дедлайна включительно (ISO-8601, UTC). */
  deadlineTo?: string;
  /** Фильтр по участникам: в Задаче назначен хотя бы один из Пользователей. */
  participantIds?: string[];
}

/** Параметры запроса списка Задач (поиск + фильтры + пагинация, Req 18). */
export interface TaskQuery {
  /** Строка подстрочного поиска по Названию/Описанию (1–256, Req 18.1). */
  text?: string;
  filters?: TaskFilters;
  page?: number;
  pageSize?: number;
}

/** DTO создания Задачи (Req 9.1). Дедлайн — ISO-8601 (UTC). */
export interface CreateTaskDto {
  title: string;
  description?: string;
  deadline: string;
  executorIds: string[];
  managerIds: string[];
}

/** Частичная правка параметров Задачи без смены Статуса (Req 10.12). */
export interface UpdateTaskDto {
  title?: string;
  description?: string | null;
  deadline?: string;
}

/** Авторитетный состав участников при назначении (Req 2.4–2.7). */
export interface AssignmentDto {
  executorIds: string[];
  managerIds: string[];
}

/** Запись справочника Пользователей для выбора участников. */
export interface DirectoryUser {
  id: string;
  name: string;
  role: UserRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function requireTaskDetail(value: unknown): TaskDetail {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !(typeof value.description === 'string' || value.description === null) ||
    !isValidDate(value.deadline) ||
    !isTaskStatus(value.status) ||
    typeof value.messageCount !== 'number' ||
    typeof value.hasUnread !== 'boolean' ||
    typeof value.isOverdue !== 'boolean' ||
    !Array.isArray(value.executorIds) ||
    !value.executorIds.every((id) => typeof id === 'string') ||
    !Array.isArray(value.managerIds) ||
    !value.managerIds.every((id) => typeof id === 'string')
  ) {
    throw new TypeError('Некорректный ответ API: ожидалась полная задача');
  }

  return value as unknown as TaskDetail;
}

function requireTaskCard(value: unknown): TaskCard {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !(typeof value.description === 'string' || value.description === null) ||
    !isValidDate(value.deadline) ||
    !isTaskStatus(value.status) ||
    typeof value.messageCount !== 'number' ||
    typeof value.hasUnread !== 'boolean' ||
    typeof value.isOverdue !== 'boolean'
  ) {
    throw new TypeError('Некорректный ответ API: ожидалась карточка задачи');
  }
  return value as unknown as TaskCard;
}

function requireTaskPage(value: unknown): Page<TaskCard> {
  const meta = isRecord(value) && isRecord(value.meta) ? value.meta : null;
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    meta === null ||
    !['page', 'pageSize', 'total', 'totalPages'].every(
      (field) => typeof meta[field] === 'number',
    ) ||
    typeof meta.hasNext !== 'boolean' ||
    typeof meta.hasPrevious !== 'boolean'
  ) {
    throw new TypeError('Некорректный ответ API: ожидалась страница задач');
  }
  return {
    items: value.items.map(requireTaskCard),
    meta: meta as unknown as PageMeta,
  };
}

function requireDirectory(value: unknown): DirectoryUser[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        ['ADMIN', 'MANAGER', 'EXECUTOR'].includes(String(item.role)),
    )
  ) {
    throw new TypeError('Некорректный ответ API: ожидался справочник пользователей');
  }
  return value as DirectoryUser[];
}

/**
 * Сериализует {@link TaskQuery} в плоский набор query-параметров.
 *
 * Массивы передаются как повторяющиеся ключи (axios по умолчанию). Пустые
 * значения опускаются, чтобы не сужать выборку без необходимости.
 */
function toParams(query: TaskQuery): Record<string, unknown> {
  const params: Record<string, unknown> = {
    page: query.page ?? PAGINATION.defaultPage,
    pageSize: query.pageSize ?? PAGINATION.defaultPageSize,
  };
  if (query.text !== undefined && query.text !== '') {
    params.text = query.text;
  }
  const f = query.filters;
  if (f !== undefined) {
    if (f.statuses !== undefined && f.statuses.length > 0) {
      params.statuses = f.statuses;
    }
    if (f.deadlineFrom !== undefined) {
      params.deadlineFrom = f.deadlineFrom;
    }
    if (f.deadlineTo !== undefined) {
      params.deadlineTo = f.deadlineTo;
    }
    if (f.participantIds !== undefined && f.participantIds.length > 0) {
      params.participantIds = f.participantIds;
    }
  }
  return params;
}

/**
 * Список видимых текущему Пользователю Задач с учётом поиска, фильтров и
 * пагинации (Req 2.8–2.10, 18). Видимость определяется backend по роли и
 * назначениям; клиент лишь передаёт параметры запроса.
 */
export async function listTasks(query: TaskQuery = {}): Promise<Page<TaskCard>> {
  return requireTaskPage(await api.get<unknown>('/tasks', toParams(query)));
}

/** Детальная Задача (Req 2.12). Backend отклоняет доступ к чужой Задаче. */
export async function getTask(taskId: string): Promise<TaskDetail> {
  return requireTaskDetail(await api.get<unknown>(`/tasks/${taskId}`));
}

/** Создание Задачи Менеджером (Req 9.1–9.5). */
export async function createTask(dto: CreateTaskDto): Promise<TaskDetail> {
  return requireTaskDetail(await api.post<unknown>('/tasks', dto));
}

/** Изменение параметров Задачи без смены Статуса (Req 10.12, 10.13). */
export async function updateTask(taskId: string, patch: UpdateTaskDto): Promise<TaskDetail> {
  return requireTaskDetail(await api.patch<unknown>(`/tasks/${taskId}`, patch));
}

/** Изменение состава участников Задачи (Req 2.4–2.7). */
export async function assignTask(
  taskId: string,
  assignment: AssignmentDto,
): Promise<TaskDetail> {
  return requireTaskDetail(await api.post<unknown>(`/tasks/${taskId}/assign`, assignment));
}

/**
 * Справочник Пользователей для выбора Исполнителей/Менеджеров в форме Задачи.
 *
 * Возвращает минимальный набор полей. Используется как best-effort: если у
 * Пользователя нет прав на справочник, вызывающий код предусматривает запасной
 * ручной ввод идентификаторов.
 */
export async function listDirectory(): Promise<DirectoryUser[]> {
  return requireDirectory(await api.get<unknown>('/users/directory'));
}
