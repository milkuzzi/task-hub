import { AssignmentKind, TaskStatus } from '@prisma/client';

/** Поля, доступные для сортировки списка задач. */
export const TASK_SORT_FIELDS = ['deadline', 'status', 'title'] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

/** Направления сортировки списка задач. */
export const TASK_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type TaskSortDirection = (typeof TASK_SORT_DIRECTIONS)[number];

/** Сортировка по умолчанию: сначала задачи с ближайшим дедлайном. */
export const DEFAULT_TASK_SORT = {
  field: 'deadline',
  direction: 'asc',
} as const satisfies { field: TaskSortField; direction: TaskSortDirection };

/**
 * Типы поиска, фильтрации и пагинации Задач (Req 18).
 *
 * Описывают предметную область поиска без привязки к инфраструктуре: строка
 * запроса (подстрочный регистронезависимый поиск, Req 18.1), набор фильтров
 * (логическое И по Статусу/Дедлайну/участникам, Req 18.3) и параметры
 * пагинации (Req 18.5). Используются как DTO-границей контроллеров, так и
 * чистыми функциями построения запроса ({@link buildSearchWhere}).
 */

/**
 * Границы строки поискового запроса (Req 18.1, 18.2).
 *
 * Строка запроса допустима при длине от 1 до 256 символов включительно; пустая
 * строка или длина свыше 256 символов отклоняются (Req 18.2).
 */
export const SEARCH_TEXT_BOUNDS = {
  /** Минимальная длина строки запроса (Req 18.1). */
  minLength: 1,
  /** Максимальная длина строки запроса (Req 18.2). */
  maxLength: 256,
} as const;

/**
 * Набор фильтров Задач, применяемых одновременно (логическое И, Req 18.3).
 *
 * Любое поле необязательно: отсутствующий фильтр не ограничивает выборку.
 * Присутствующие фильтры комбинируются конъюнктивно — результат должен
 * удовлетворять всем выбранным условиям сразу (Req 18.3).
 */
export interface TaskFilters {
  /** Фильтр по Статусу: Задача должна иметь один из перечисленных Статусов. */
  statuses?: TaskStatus[];
  /** Нижняя граница Дедлайна (включительно). */
  deadlineFrom?: Date;
  /** Верхняя граница Дедлайна (включительно). */
  deadlineTo?: Date;
  /** Фильтр по участникам: в Задаче назначен хотя бы один из Пользователей. */
  participantIds?: string[];
  /** Фильтр по виду назначения текущего Пользователя в Задаче. */
  assignmentKind?: AssignmentKind;
}

/**
 * Поисковый запрос Задач (Req 18.1, 18.3, 18.5).
 *
 * @property text Строка подстрочного поиска по Названию/Описанию (1–256, Req 18.1).
 * @property filters Набор фильтров (логическое И, Req 18.3).
 * @property page Номер страницы (по умолчанию 1, Req 18.5, 18.6).
 * @property pageSize Размер страницы (по умолчанию 20, максимум 100, Req 18.5).
 */
export interface SearchQuery {
  text?: string;
  filters?: TaskFilters;
  sortBy?: TaskSortField;
  sortDirection?: TaskSortDirection;
  page?: number;
  pageSize?: number;
}

/**
 * Нормализованные и проверенные фильтры Задач.
 *
 * Получаются из {@link TaskFilters} после прикладной валидации значений
 * (Req 18.4): пустые/отсутствующие фильтры приводятся к `undefined`, диапазон
 * Дедлайна гарантированно непротиворечив (`from <= to`).
 */
export interface NormalizedTaskFilters {
  statuses?: TaskStatus[];
  deadlineFrom?: Date;
  deadlineTo?: Date;
  participantIds?: string[];
  assignmentKind?: AssignmentKind;
}

/**
 * Нормализованный поисковый запрос после валидации (Req 18.2, 18.4, 18.7).
 *
 * Строка запроса и фильтры уже проверены; недопустимый запрос до получения
 * этого результата отклоняется исключением, поэтому текущий список Задач не
 * изменяется (Req 18.7).
 */
export interface NormalizedSearchQuery {
  text?: string;
  filters?: NormalizedTaskFilters;
  sortBy: TaskSortField;
  sortDirection: TaskSortDirection;
}
