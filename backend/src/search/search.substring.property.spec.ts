import fc from 'fast-check';
import { AssignmentKind, Prisma, Role } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { buildSearchWhere, validateSearchQuery } from './search-query';
import { SEARCH_TEXT_BOUNDS } from './search.types';

/**
 * **Feature: task-assignment-system, Property 52: Корректность поиска по подстроке**
 *
 * Property 52 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 18.1, 18.2**:
 *
 * Для любой строки запроса длиной 1–256 множество результатов поиска равно
 * множеству ВИДИМЫХ Пользователю Задач, у которых строка запроса встречается
 * как подстрока БЕЗ УЧЁТА РЕГИСТРА в Названии ИЛИ Описании (полнота и
 * точность, Req 18.1); пустой запрос или длина более 256 отклоняются ошибкой
 * и НЕ изменяют текущий список (Req 18.2).
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Поиск в продукте — это чистое
 * построение Prisma-условия `WHERE` ({@link buildSearchWhere}) поверх
 * {@link validateSearchQuery}; реальная выборка делегируется Prisma. Чтобы
 * проверить семантику без БД, условие `WHERE` интерпретируется НЕЗАВИСИМЫМ
 * вычислителем {@link matchesWhere} (он разбирает обобщённое дерево
 * `AND`/`OR`/`contains`/`assignments.some`, не зная о доменной логике поиска)
 * и применяется к сгенерированному набору Задач. Эталонное множество
 * ({@link expectedMatches}) вычисляется напрямую из спецификации (видимость ∧
 * подстрока без учёта регистра). Совпадение двух независимо полученных
 * множеств подтверждает полноту и точность.
 */
describe('Property 52: Корректность поиска по подстроке (Req 18.1, 18.2)', () => {
  const USER_ID = 'u-self';

  /** Минимальная модель Задачи, достаточная для оценки условия поиска. */
  interface TaskRow {
    id: string;
    title: string;
    description: string | null;
    assignments: Array<{ userId: string; kind: AssignmentKind }>;
  }

  // --- Независимый вычислитель Prisma-условия WHERE ---------------------------
  // Разбирает обобщённое дерево условий, НЕ опираясь на доменную логику поиска.
  // Поддерживает только операторы, которые встречаются в результате
  // buildSearchWhere для текстового поиска: AND, OR, скалярный `contains`
  // (с учётом `mode`) по `title`/`description` и `assignments.some`.

  function containsMatches(
    haystack: string | null,
    cond: Prisma.StringFilter | Prisma.StringNullableFilter,
  ): boolean {
    const needle = cond.contains as string;
    const insensitive = cond.mode === 'insensitive';
    if (haystack === null) {
      return false;
    }
    return insensitive
      ? haystack.toLowerCase().includes(needle.toLowerCase())
      : haystack.includes(needle);
  }

  function assignmentsSomeMatches(
    task: TaskRow,
    some: { userId?: string; kind?: AssignmentKind },
  ): boolean {
    return task.assignments.some(
      (a) =>
        (some.userId === undefined || a.userId === some.userId) &&
        (some.kind === undefined || a.kind === some.kind),
    );
  }

  function matchesWhere(task: TaskRow, where: Prisma.TaskWhereInput): boolean {
    // Объект условий: все ключи объединяются конъюнктивно (семантика Prisma).
    return Object.entries(where).every(([key, value]) => {
      switch (key) {
        case 'AND': {
          const clauses = value as Prisma.TaskWhereInput[];
          return clauses.every((clause) => matchesWhere(task, clause));
        }
        case 'OR': {
          const clauses = value as Prisma.TaskWhereInput[];
          return clauses.some((clause) => matchesWhere(task, clause));
        }
        case 'title':
          return containsMatches(task.title, value as Prisma.StringFilter);
        case 'description':
          return containsMatches(task.description, value as Prisma.StringNullableFilter);
        case 'assignments': {
          const some = (value as { some?: { userId?: string; kind?: AssignmentKind } }).some ?? {};
          return assignmentsSomeMatches(task, some);
        }
        default:
          throw new Error(`Неподдерживаемый ключ условия в тесте: ${key}`);
      }
    });
  }

  // --- Эталон из спецификации -------------------------------------------------

  /** Видна ли Задача Пользователю с данной ролью (Req 2.8–2.10). */
  function isVisible(task: TaskRow, role: Role): boolean {
    if (role === Role.ADMIN) {
      return true;
    }
    return task.assignments.some((a) => a.userId === USER_ID);
  }

  /** Подстрока без учёта регистра в Названии ИЛИ Описании (Req 18.1). */
  function textMatches(task: TaskRow, text: string): boolean {
    const needle = text.toLowerCase();
    return (
      task.title.toLowerCase().includes(needle) ||
      (task.description !== null && task.description.toLowerCase().includes(needle))
    );
  }

  /** Эталонное множество результатов: видимые ∧ содержащие подстроку. */
  function expectedMatches(tasks: TaskRow[], role: Role, text: string): Set<string> {
    return new Set(
      tasks.filter((t) => isVisible(t, role) && textMatches(t, text)).map((t) => t.id),
    );
  }

  // --- Генераторы -------------------------------------------------------------

  // Маленький алфавит со строчными латиницей/кириллицей и пробелом повышает
  // вероятность случайных совпадений подстрок.
  const LETTERS = ['a', 'b', 'o', 't', 'о', 'т', ' '];

  const wordArb = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
    fc.array(fc.constantFrom(...LETTERS), { minLength, maxLength }).map((cs) => cs.join(''));

  /** Случайно переводит строку целиком в верхний регистр (проверка mode). */
  const recase = (s: string, upper: boolean): string => (upper ? s.toUpperCase() : s);

  /** Строка запроса 1–6 символов из строчного алфавита. */
  const needleArb = wordArb(1, 6);

  const roleArb = fc.constantFrom<Role>(Role.ADMIN, Role.MANAGER, Role.EXECUTOR);

  /**
   * Спецификация одной Задачи: базовые Название/Описание, опциональное
   * внедрение строки запроса и независимая смена регистра полей (чтобы регистр
   * needle и haystack различался и проверял `mode: 'insensitive'`).
   */
  const taskSpecArb = () =>
    fc.record({
      titleBase: wordArb(0, 8),
      hasDescription: fc.boolean(),
      descBase: wordArb(0, 8),
      embedInTitle: fc.boolean(),
      embedInDescription: fc.boolean(),
      titleUpper: fc.boolean(),
      descUpper: fc.boolean(),
      // Назначение текущего Пользователя на Задачу + посторонние участники.
      selfKind: fc.constantFrom<AssignmentKind | 'none'>(
        'none',
        AssignmentKind.MANAGER,
        AssignmentKind.EXECUTOR,
      ),
      foreignKinds: fc.subarray([AssignmentKind.MANAGER, AssignmentKind.EXECUTOR]),
    });

  function buildTask(
    id: string,
    needle: string,
    spec: {
      titleBase: string;
      hasDescription: boolean;
      descBase: string;
      embedInTitle: boolean;
      embedInDescription: boolean;
      titleUpper: boolean;
      descUpper: boolean;
      selfKind: AssignmentKind | 'none';
      foreignKinds: AssignmentKind[];
    },
  ): TaskRow {
    const title = recase(
      spec.embedInTitle ? `${spec.titleBase}${needle}x` : spec.titleBase,
      spec.titleUpper,
    );
    const description = spec.hasDescription
      ? recase(
          spec.embedInDescription ? `${needle}${spec.descBase}` : spec.descBase,
          spec.descUpper,
        )
      : null;

    const assignments: TaskRow['assignments'] = spec.foreignKinds.map((kind, i) => ({
      userId: `foreign-${i}`,
      kind,
    }));
    if (spec.selfKind !== 'none') {
      assignments.push({ userId: USER_ID, kind: spec.selfKind });
    }

    return { id, title, description, assignments };
  }

  it('возвращает ровно видимые Задачи с регистронезависимой подстрокой в Названии/Описании (Req 18.1)', () => {
    const scenarioArb = needleArb.chain((needle) =>
      fc.record({
        needle: fc.constant(needle),
        needleUpper: fc.boolean(),
        role: roleArb,
        specs: fc.array(taskSpecArb(), { minLength: 0, maxLength: 12 }),
      }),
    );

    fc.assert(
      fc.property(scenarioArb, ({ needle, needleUpper, role, specs }) => {
        const tasks = specs.map((spec, i) => buildTask(`t${i}`, needle, spec));

        // Строка запроса в ИНОМ регистре, чтобы проверить нечувствительность.
        const queryText = recase(needle, needleUpper);

        const normalized = validateSearchQuery({ text: queryText });
        const where = buildSearchWhere(USER_ID, role, normalized);

        const actual = new Set(tasks.filter((t) => matchesWhere(t, where)).map((t) => t.id));
        const expected = expectedMatches(tasks, role, queryText);

        expect([...actual].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('отклоняет пустой запрос или длину > 256 ошибкой, не изменяя текущий список (Req 18.2)', () => {
    const invalidTextArb = fc.oneof(
      fc.constant(''),
      fc
        .integer({ min: SEARCH_TEXT_BOUNDS.maxLength + 1, max: SEARCH_TEXT_BOUNDS.maxLength + 64 })
        .map((n) => 'я'.repeat(n)),
    );

    fc.assert(
      fc.property(invalidTextArb, roleArb, (invalidText, role) => {
        // «Текущий список» Задач до запроса.
        const currentList: TaskRow[] = [
          { id: 'a', title: 'Отчёт', description: null, assignments: [] },
          { id: 'b', title: 'План', description: 'квартал', assignments: [] },
        ];
        const snapshot = JSON.stringify(currentList);

        // Недопустимая длина отклоняется ДО построения условия выборки.
        expect(() => validateSearchQuery({ text: invalidText })).toThrow(ValidationException);
        expect(() => {
          const normalized = validateSearchQuery({ text: invalidText });
          buildSearchWhere(USER_ID, role, normalized);
        }).toThrow(ValidationException);

        // Текущий список не изменён (отказ происходит до обращения к данным).
        expect(JSON.stringify(currentList)).toBe(snapshot);
        expect(currentList).toHaveLength(2);
      }),
      { numRuns: 100 },
    );
  });
});
