import { AssignmentKind, Prisma, Role, TaskStatus } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { hasAdminPrivileges } from '../users/permissions';
import {
  NormalizedSearchQuery,
  NormalizedTaskFilters,
  DEFAULT_TASK_SORT,
  SEARCH_TEXT_BOUNDS,
  SearchQuery,
  TASK_SORT_DIRECTIONS,
  TASK_SORT_FIELDS,
  TaskFilters,
} from './search.types';

/**
 * Чистые, детерминированные функции поиска, фильтрации и построения запроса
 * Задач (Req 18.1–18.7).
 *
 * Логика валидации строки запроса и значений фильтров, а также построение
 * Prisma-условия `WHERE` вынесены из сервиса в чистые функции, чтобы их можно
 * было детерминированно проверить модульными и property-based-тестами
 * (свойства 52–54) без обращения к базе данных. Все функции либо возвращают
 * нормализованный результат, либо выбрасывают {@link ValidationException} ДО
 * какого-либо изменения состояния, поэтому при недопустимых параметрах текущий
 * список Задач остаётся без изменений (Req 18.2, 18.4, 18.7).
 */

/** Множество допустимых Статусов Задачи для проверки значений фильтра. */
const VALID_STATUSES: ReadonlySet<string> = new Set(Object.values(TaskStatus));
const VALID_ASSIGNMENT_KINDS: ReadonlySet<string> = new Set(Object.values(AssignmentKind));
const VALID_SORT_FIELDS: ReadonlySet<string> = new Set(TASK_SORT_FIELDS);
const VALID_SORT_DIRECTIONS: ReadonlySet<string> = new Set(TASK_SORT_DIRECTIONS);

/**
 * Проверяет строку поискового запроса против границ длины (Req 18.1, 18.2).
 *
 * Отсутствующая строка (`undefined`) означает поиск без подстрочного условия и
 * допустима. Присутствующая строка должна иметь длину от 1 до 256 символов
 * включительно; пустая строка или длина свыше 256 символов отклоняется
 * {@link ValidationException} с указанием на недопустимую длину (Req 18.2).
 *
 * Строка возвращается без изменения регистра — регистронезависимость
 * обеспечивается на уровне запроса ({@link buildTextWhere}, `mode: 'insensitive'`).
 *
 * @param text Строка запроса либо `undefined`.
 * @returns Та же строка (если задана) либо `undefined`.
 * @throws ValidationException Длина строки запроса вне диапазона 1–256 (Req 18.2).
 */
export function validateSearchText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  if (typeof text !== 'string') {
    throw new ValidationException('Строка запроса должна быть строкой.');
  }
  if (text.length < SEARCH_TEXT_BOUNDS.minLength || text.length > SEARCH_TEXT_BOUNDS.maxLength) {
    throw new ValidationException(
      `Строка запроса должна содержать от ${SEARCH_TEXT_BOUNDS.minLength} до ${SEARCH_TEXT_BOUNDS.maxLength} символов.`,
    );
  }
  return text;
}

/**
 * Проверяет значения фильтров Задач и нормализует их (Req 18.3, 18.4).
 *
 * Отсутствующий набор фильтров (`undefined`) допустим и означает отсутствие
 * ограничений. Для присутствующих фильтров проверяется:
 * - **Статус**: каждое значение должно быть допустимым {@link TaskStatus};
 *   пустой список Статусов трактуется как отсутствие фильтра по Статусу;
 * - **Дедлайн**: границы `deadlineFrom`/`deadlineTo` должны быть корректными
 *   датами; при наличии обеих нижняя граница не может превышать верхнюю;
 * - **Участники**: каждый идентификатор — непустая строка; пустой список
 *   трактуется как отсутствие фильтра по участникам.
 *
 * Любое недопустимое значение немедленно отклоняет запрос
 * {@link ValidationException} (Req 18.4) ДО изменения состояния, поэтому
 * текущий список не меняется. Если после нормализации не осталось ни одного
 * активного условия, возвращается `undefined`.
 *
 * @param filters Набор фильтров либо `undefined`.
 * @returns Нормализованные фильтры либо `undefined`, если фильтры отсутствуют.
 * @throws ValidationException Значение хотя бы одного фильтра недопустимо (Req 18.4).
 */
export function validateTaskFilters(
  filters: TaskFilters | undefined,
): NormalizedTaskFilters | undefined {
  if (filters === undefined) {
    return undefined;
  }

  const normalized: NormalizedTaskFilters = {};

  if (filters.statuses !== undefined) {
    if (!Array.isArray(filters.statuses)) {
      throw new ValidationException('Фильтр по Статусу должен быть списком значений.');
    }
    for (const status of filters.statuses) {
      if (!VALID_STATUSES.has(status as string)) {
        throw new ValidationException(`Недопустимое значение фильтра по Статусу: «${status}».`);
      }
    }
    if (filters.statuses.length > 0) {
      normalized.statuses = [...new Set(filters.statuses)];
    }
  }

  const from = validateFilterDate(filters.deadlineFrom, 'нижней границы Дедлайна');
  const to = validateFilterDate(filters.deadlineTo, 'верхней границы Дедлайна');
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    throw new ValidationException('Недопустимый диапазон Дедлайна: нижняя граница позже верхней.');
  }
  if (from !== undefined) {
    normalized.deadlineFrom = from;
  }
  if (to !== undefined) {
    normalized.deadlineTo = to;
  }

  if (filters.participantIds !== undefined) {
    if (!Array.isArray(filters.participantIds)) {
      throw new ValidationException('Фильтр по участникам должен быть списком идентификаторов.');
    }
    for (const id of filters.participantIds) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new ValidationException('Недопустимый идентификатор участника в фильтре.');
      }
    }
    if (filters.participantIds.length > 0) {
      normalized.participantIds = [...new Set(filters.participantIds)];
    }
  }

  if (filters.assignmentKind !== undefined) {
    if (!VALID_ASSIGNMENT_KINDS.has(filters.assignmentKind as string)) {
      throw new ValidationException(
        `Недопустимое значение фильтра по роли в задаче: «${filters.assignmentKind}».`,
      );
    }
    normalized.assignmentKind = filters.assignmentKind;
  }

  return hasActiveFilter(normalized) ? normalized : undefined;
}

/**
 * Проверяет границу Дедлайна фильтра: должна быть корректной датой либо
 * отсутствовать (Req 18.4).
 *
 * @throws ValidationException Если значение задано, но не является корректной датой.
 */
function validateFilterDate(value: Date | undefined, label: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ValidationException(`Недопустимое значение ${label} в фильтре.`);
  }
  return value;
}

/** Сообщает, содержит ли набор нормализованных фильтров хотя бы одно условие. */
function hasActiveFilter(filters: NormalizedTaskFilters): boolean {
  return (
    filters.statuses !== undefined ||
    filters.deadlineFrom !== undefined ||
    filters.deadlineTo !== undefined ||
    filters.participantIds !== undefined ||
    filters.assignmentKind !== undefined
  );
}

/**
 * Проверяет и нормализует весь поисковый запрос (строку и фильтры) как единое
 * целое (Req 18.7).
 *
 * При одновременном применении поиска и фильтрации, если недопустим хотя бы
 * один параметр (строка запроса или значение фильтра), отклоняется весь запрос
 * целиком {@link ValidationException} (Req 18.7); поскольку проверка
 * выполняется до обращения к данным, текущий список Задач не изменяется.
 *
 * @param query Исходный поисковый запрос.
 * @returns Нормализованные строка и фильтры.
 * @throws ValidationException Недопустима строка запроса (Req 18.2) или значение
 *   фильтра (Req 18.4).
 */
export function validateSearchQuery(query: SearchQuery): NormalizedSearchQuery {
  const text = validateSearchText(query.text);
  const filters = validateTaskFilters(query.filters);
  const sortBy = query.sortBy ?? DEFAULT_TASK_SORT.field;
  const sortDirection = query.sortDirection ?? DEFAULT_TASK_SORT.direction;
  if (!VALID_SORT_FIELDS.has(sortBy)) {
    throw new ValidationException(`Недопустимое поле сортировки: «${sortBy}».`);
  }
  if (!VALID_SORT_DIRECTIONS.has(sortDirection)) {
    throw new ValidationException(`Недопустимое направление сортировки: «${sortDirection}».`);
  }

  const result: NormalizedSearchQuery = { sortBy, sortDirection };
  if (text !== undefined) {
    result.text = text;
  }
  if (filters !== undefined) {
    result.filters = filters;
  }
  return result;
}

/**
 * Строит условие видимости Задач по доступу Пользователя
 * (Req 2.8–2.10, 18.1, 18.3).
 *
 * Администратор видит все Задачи (Req 2.10); остальные Пользователи видят
 * Задачи, где они назначены в любом виде. Это синхронизирует список с прямым
 * доступом к карточке из уведомления.
 *
 * @param userId Идентификатор Пользователя.
 * @param role Глобальная роль Пользователя.
 * @returns Prisma-условие видимости.
 */
export function buildVisibilityWhere(userId: string, role: Role): Prisma.TaskWhereInput {
  if (hasAdminPrivileges(role)) {
    return {};
  }
  return { assignments: { some: { userId } } };
}

/**
 * Строит условие подстрочного регистронезависимого поиска по Названию или
 * Описанию (Req 18.1).
 *
 * Возвращает `undefined`, если строка поиска отсутствует. Совпадение
 * засчитывается, если строка встречается как подстрока в Названии ИЛИ Описании
 * (регистр не учитывается, `mode: 'insensitive'`).
 */
function buildTextWhere(text: string | undefined): Prisma.TaskWhereInput | undefined {
  if (text === undefined) {
    return undefined;
  }
  return {
    OR: [
      { title: { contains: text, mode: 'insensitive' } },
      { description: { contains: text, mode: 'insensitive' } },
    ],
  };
}

/**
 * Строит условия фильтров Задач (Req 18.3).
 *
 * Возвращает массив самостоятельных условий (по одному на активный фильтр),
 * которые объединяются конъюнктивно ({@link buildSearchWhere}) — результат
 * удовлетворяет всем выбранным фильтрам одновременно (логическое И, Req 18.3).
 */
function buildFilterWhere(
  userId: string,
  filters: NormalizedTaskFilters | undefined,
): Prisma.TaskWhereInput[] {
  if (filters === undefined) {
    return [];
  }
  const clauses: Prisma.TaskWhereInput[] = [];

  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    clauses.push({ status: { in: filters.statuses } });
  }

  if (filters.deadlineFrom !== undefined || filters.deadlineTo !== undefined) {
    const deadline: Prisma.DateTimeFilter = {};
    if (filters.deadlineFrom !== undefined) {
      deadline.gte = filters.deadlineFrom;
    }
    if (filters.deadlineTo !== undefined) {
      deadline.lte = filters.deadlineTo;
    }
    clauses.push({ deadline });
  }

  if (filters.participantIds !== undefined && filters.participantIds.length > 0) {
    clauses.push({ assignments: { some: { userId: { in: filters.participantIds } } } });
  }

  if (filters.assignmentKind !== undefined) {
    clauses.push({
      assignments: { some: { userId, kind: filters.assignmentKind } },
    });
  }

  return clauses;
}

/**
 * Чистая, детерминированная функция построения Prisma-условия `WHERE` для
 * поиска Задач: конъюнкция видимости, подстрочного поиска и фильтров
 * (видимость ∧ текст ∧ фильтры) (Req 18.1, 18.3).
 *
 * Видимость применяется всегда (Req 2.8–2.10); условие поиска и условия
 * фильтров добавляются только при их наличии. Все условия объединяются через
 * `AND`, поэтому каждая возвращаемая Задача находится в пределах видимости
 * Пользователя, содержит подстроку запроса (если задана) и удовлетворяет всем
 * фильтрам одновременно (Req 18.3).
 *
 * Функция предполагает, что строка запроса и фильтры уже проверены
 * ({@link validateSearchQuery}); сама она состояние не изменяет и к данным не
 * обращается.
 *
 * @param userId Идентификатор Пользователя.
 * @param role Глобальная роль Пользователя.
 * @param query Нормализованный поисковый запрос (строка и фильтры).
 * @returns Prisma-условие `WHERE` для выборки Задач.
 */
export function buildSearchWhere(
  userId: string,
  role: Role,
  query: Pick<NormalizedSearchQuery, 'text' | 'filters'>,
): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [buildVisibilityWhere(userId, role)];

  const textWhere = buildTextWhere(query.text);
  if (textWhere !== undefined) {
    and.push(textWhere);
  }

  and.push(...buildFilterWhere(userId, query.filters));

  return { AND: and };
}
