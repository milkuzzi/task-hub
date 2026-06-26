import fc from 'fast-check';
import { AssignmentKind, Prisma, Role, TaskStatus } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { buildSearchWhere, validateSearchQuery, validateTaskFilters } from './search-query';
import { NormalizedTaskFilters, TaskFilters } from './search.types';

/**
 * **Feature: task-assignment-system, Property 53: Корректность фильтрации (логическое И)**
 *
 * Property 53 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 18.3, 18.4, 18.7**:
 *
 * Для любого набора фильтров по Статусу/Дедлайну/участникам каждый результат
 * удовлетворяет одновременно ВСЕМ выбранным условиям (логическое И, Req 18.3) и
 * находится в пределах видимости Пользователя (Req 2.8–2.10); недопустимое
 * значение любого фильтра отклоняет запрос целиком ({@link ValidationException},
 * Req 18.4) — в том числе при одновременном применении поиска и фильтрации
 * (Req 18.7) — без изменения текущего списка Задач.
 *
 * Тест реализует ровно ЭТО ОДНО свойство и работает с чистыми детерминированными
 * функциями построения запроса ({@link buildSearchWhere}, {@link validateTaskFilters},
 * {@link validateSearchQuery}) — без обращения к БД. Условие `WHERE`, построенное
 * по нормализованным фильтрам, интерпретируется независимым in-memory-матчером и
 * сравнивается с эталонным множеством, вычисленным прямым применением семантики
 * «видимость ∧ Статус ∧ Дедлайн ∧ участники». Совпадение множеств доказывает,
 * что фильтры объединяются строго конъюнктивно в пределах видимости.
 */
describe('Property 53: Корректность фильтрации (логическое И) (Req 18.3, 18.4, 18.7)', () => {
  const STATUSES = Object.values(TaskStatus);
  const USER_POOL = ['u1', 'u2', 'u3', 'u4', 'u5'] as const;

  // Дискретный диапазон Дедлайнов (в днях от опорной даты) для пересекающихся границ.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BASE = Date.UTC(2030, 0, 1);
  const dateFromDay = (day: number): Date => new Date(BASE + day * DAY_MS);

  interface TestTask {
    id: string;
    status: TaskStatus;
    deadline: Date;
    assignments: { userId: string; kind: AssignmentKind }[];
  }

  // ---- Генераторы ---------------------------------------------------------

  const assignmentArb = fc.record({
    userId: fc.constantFrom(...USER_POOL),
    kind: fc.constantFrom(AssignmentKind.MANAGER, AssignmentKind.EXECUTOR),
  });

  const taskArb = fc.record({
    id: fc.uuid(),
    status: fc.constantFrom(...STATUSES),
    deadline: fc.integer({ min: 0, max: 30 }).map(dateFromDay),
    assignments: fc.array(assignmentArb, { minLength: 0, maxLength: 4 }),
  });

  const tasksArb = fc.uniqueArray(taskArb, {
    minLength: 0,
    maxLength: 12,
    selector: (t) => t.id,
  });

  const viewerArb = fc.record({
    userId: fc.constantFrom(...USER_POOL),
    role: fc.constantFrom(Role.ADMIN, Role.MANAGER, Role.EXECUTOR),
  });

  /** Допустимый набор фильтров: любое подмножество условий может отсутствовать. */
  const validFiltersArb: fc.Arbitrary<TaskFilters> = fc
    .record({
      statuses: fc.option(fc.subarray([...STATUSES]), { nil: undefined }),
      deadlineRange: fc.option(
        fc
          .tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }))
          .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const),
        { nil: undefined },
      ),
      participantIds: fc.option(fc.subarray([...USER_POOL]), { nil: undefined }),
    })
    .map(({ statuses, deadlineRange, participantIds }) => {
      const filters: TaskFilters = {};
      if (statuses !== undefined) filters.statuses = statuses;
      if (deadlineRange !== undefined) {
        filters.deadlineFrom = dateFromDay(deadlineRange[0]);
        filters.deadlineTo = dateFromDay(deadlineRange[1]);
      }
      if (participantIds !== undefined) filters.participantIds = participantIds;
      return filters;
    });

  // ---- Эталонная семантика (независимая от построения WHERE) ---------------

  function isVisible(task: TestTask, viewer: { userId: string; role: Role }): boolean {
    if (viewer.role === Role.ADMIN) return true;
    return task.assignments.some((a) => a.userId === viewer.userId);
  }

  function matchesFilters(task: TestTask, filters: NormalizedTaskFilters | undefined): boolean {
    if (filters === undefined) return true;
    if (filters.statuses !== undefined && !filters.statuses.includes(task.status)) return false;
    if (
      filters.deadlineFrom !== undefined &&
      task.deadline.getTime() < filters.deadlineFrom.getTime()
    ) {
      return false;
    }
    if (
      filters.deadlineTo !== undefined &&
      task.deadline.getTime() > filters.deadlineTo.getTime()
    ) {
      return false;
    }
    if (
      filters.participantIds !== undefined &&
      !task.assignments.some((a) => filters.participantIds!.includes(a.userId))
    ) {
      return false;
    }
    return true;
  }

  // ---- Интерпретатор Prisma-условия WHERE, построенного buildSearchWhere ---

  /** Применяет одну элементарную клаузу из массива AND к Задаче. */
  function clauseMatches(task: TestTask, clause: Prisma.TaskWhereInput): boolean {
    // Видимость Администратора: пустое условие — всегда истинно.
    if (Object.keys(clause).length === 0) return true;

    if (clause.status !== undefined) {
      const inList = (clause.status as Prisma.EnumTaskStatusFilter).in as TaskStatus[];
      return inList.includes(task.status);
    }

    if (clause.deadline !== undefined) {
      const f = clause.deadline as Prisma.DateTimeFilter;
      if (f.gte !== undefined && task.deadline.getTime() < (f.gte as Date).getTime()) return false;
      if (f.lte !== undefined && task.deadline.getTime() > (f.lte as Date).getTime()) return false;
      return true;
    }

    if (clause.assignments !== undefined) {
      const some = (clause.assignments as Prisma.TaskAssignmentListRelationFilter).some as Record<
        string,
        unknown
      >;
      const userId = some.userId;
      // Фильтр по участникам: { userId: { in: [...] } }.
      if (userId !== null && typeof userId === 'object') {
        const inList = (userId as { in: string[] }).in;
        return task.assignments.some((a) => inList.includes(a.userId));
      }
      // Видимость по роли: { userId, kind }.
      const kind = some.kind;
      const matchesKind = (candidate: AssignmentKind): boolean => {
        if (kind === undefined) {
          return true;
        }
        if (typeof kind === 'object' && kind !== null && 'in' in kind) {
          return ((kind as { in?: AssignmentKind[] }).in ?? []).includes(candidate);
        }
        return candidate === kind;
      };
      return task.assignments.some((a) => a.userId === userId && matchesKind(a.kind));
    }

    throw new Error(`Неизвестная клауза WHERE: ${JSON.stringify(clause)}`);
  }

  /** Задача проходит конъюнкцию AND, если удовлетворяет каждой клаузе. */
  function whereMatches(task: TestTask, where: Prisma.TaskWhereInput): boolean {
    const and = (where.AND as Prisma.TaskWhereInput[]) ?? [];
    return and.every((clause) => clauseMatches(task, clause));
  }

  it('результат = видимость ∧ Статус ∧ Дедлайн ∧ участники (логическое И, Req 18.3)', () => {
    fc.assert(
      fc.property(tasksArb, viewerArb, validFiltersArb, (tasks, viewer, rawFilters) => {
        const normalized = validateTaskFilters(rawFilters);
        const query = normalized === undefined ? {} : { filters: normalized };
        const where = buildSearchWhere(viewer.userId, viewer.role, query);

        const actual = (tasks as TestTask[]).filter((t) => whereMatches(t, where)).map((t) => t.id);
        const expected = (tasks as TestTask[])
          .filter((t) => isVisible(t, viewer) && matchesFilters(t, normalized))
          .map((t) => t.id);

        expect(new Set(actual)).toEqual(new Set(expected));

        // Каждый результат действительно удовлетворяет ВСЕМ условиям одновременно.
        for (const t of tasks as TestTask[]) {
          if (actual.includes(t.id)) {
            expect(isVisible(t, viewer)).toBe(true);
            expect(matchesFilters(t, normalized)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // ---- Недопустимые значения фильтров: отказ без изменения списка ----------

  /** Генератор заведомо недопустимого набора фильтров (Req 18.4). */
  const invalidFiltersArb: fc.Arbitrary<TaskFilters> = fc.oneof(
    // Недопустимое значение Статуса.
    fc.record({ statuses: fc.constant(['НЕ_СТАТУС' as TaskStatus]) }),
    // Перевёрнутый диапазон Дедлайна (нижняя граница позже верхней).
    fc.tuple(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 })).map(([a, b]) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b) === lo ? lo + 1 : Math.max(a, b);
      return { deadlineFrom: dateFromDay(hi), deadlineTo: dateFromDay(lo) };
    }),
    // Некорректная дата Дедлайна.
    fc.constant({ deadlineFrom: new Date('not-a-date') }),
    // Пустой идентификатор участника.
    fc.constant({ participantIds: [''] }),
  );

  it('недопустимый фильтр отклоняет запрос целиком, текущий список не меняется (Req 18.4, 18.7)', () => {
    fc.assert(
      fc.property(
        tasksArb,
        invalidFiltersArb,
        fc.option(fc.string({ minLength: 1, maxLength: 256 }), { nil: undefined }),
        (tasks, badFilters, text) => {
          const snapshot = (tasks as TestTask[]).map((t) => t.id);

          // Только фильтрация — отклоняется (Req 18.4).
          expect(() => validateTaskFilters(badFilters)).toThrow(ValidationException);

          // Поиск + фильтрация одновременно — весь запрос отклоняется целиком (Req 18.7).
          const query =
            text === undefined ? { filters: badFilters } : { text, filters: badFilters };
          expect(() => validateSearchQuery(query)).toThrow(ValidationException);

          // Текущий список Задач остаётся без изменений (валидация чиста, до данных не доходит).
          expect((tasks as TestTask[]).map((t) => t.id)).toEqual(snapshot);
        },
      ),
      { numRuns: 200 },
    );
  });
});
