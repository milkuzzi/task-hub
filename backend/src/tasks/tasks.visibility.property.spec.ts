import 'reflect-metadata';
import fc from 'fast-check';
import { AssignmentKind, Prisma, Role, Task, TaskStatus, User } from '@prisma/client';
import { PaginationQueryDto, PAGINATION } from '../common/dto';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { TasksService } from './tasks.service';

/**
 * **Feature: task-assignment-system, Property 6: Видимость задач по роли и назначениям**
 *
 * Property 6 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 2.8, 2.9, 2.10, 16.7**:
 *
 * Для ЛЮБОГО набора Задач с назначениями и ЛЮБОГО Пользователя множество
 * видимых ему Задач равно строго:
 * - для Исполнителя — ровно тем Задачам, где он назначен Исполнителем (Req 2.8);
 * - для Менеджера — ровно тем Задачам, где он назначен Менеджером (Req 2.9);
 * - для Администратора — всем Задачам (Req 2.10).
 *
 * То же множество предоставляет список Задач Бота MAX (Req 16.7): и веб-список,
 * и команда Бота используют единый путь {@link TasksService.listVisible} с
 * условием видимости по роли и назначениям, поэтому проверка этого свойства
 * над `listVisible` одновременно подтверждает идентичность набора, выдаваемого
 * Ботом MAX.
 *
 * Тест реализует РОВНО ЭТО ОДНО свойство. Внешние границы
 * ({@link TaskRepository}, {@link UserRepository}, {@link AppConfigService})
 * подменяются stateful in-memory моками — обращений к реальной БД/Redis нет.
 * Мок-репозиторий хранит Задачи с их назначениями и реализует `list(query,
 * where)`, честно интерпретируя то же условие видимости, что строит сервис, а
 * также пагинацию; Пользователи всегда активны, поэтому единственным фактором
 * исхода остаётся роль запрашивающего и его назначения.
 */
describe('Property 6: Видимость задач по роли и назначениям (Req 2.8, 2.9, 2.10, 16.7)', () => {
  /** Описание одного назначения внутри сгенерированной Задачи. */
  interface AssignmentSpec {
    userId: string;
    kind: AssignmentKind;
  }

  /** Сгенерированная Задача: идентификатор и список назначений. */
  interface TaskSpec {
    id: string;
    assignments: AssignmentSpec[];
  }

  /** Полный сценарий: пул Пользователей с ролями и набор Задач. */
  interface Scenario {
    users: Array<{ id: string; role: Role }>;
    tasks: TaskSpec[];
  }

  /**
   * Минимальная интерпретация условия видимости из приватного
   * `TasksService.buildVisibilityWhere`: пустое условие — все Задачи
   * (Администратор), иначе — Задачи с назначением, совпадающим по `userId` и
   * `kind` (Менеджер/Исполнитель).
   */
  function matchesWhere(task: TaskWithAssignments, where: Prisma.TaskWhereInput): boolean {
    if (Object.keys(where).length === 0) {
      return true;
    }
    const some = (
      where.assignments as
        | { some?: { userId?: string; kind?: AssignmentKind | { in?: AssignmentKind[] } } }
        | undefined
    )?.some;
    if (some === undefined) {
      return true;
    }
    // Вид назначения может быть одиночным `kind` (Исполнитель) либо формой
    // `kind: { in: [...] }` (Менеджер видит Задачи, где он Менеджер ИЛИ
    // Исполнитель, Req 2.7).
    const kindMatches = (kind: AssignmentKind): boolean => {
      const cond = some.kind;
      if (cond === undefined) {
        return true;
      }
      if (typeof cond === 'object' && cond !== null && 'in' in cond) {
        return (cond.in ?? []).includes(kind);
      }
      return kind === cond;
    };
    return task.assignments.some((a) => a.userId === some.userId && kindMatches(a.kind));
  }

  /** Преобразует {@link TaskSpec} в строго типизированную Задачу с назначениями. */
  function toTaskWithAssignments(spec: TaskSpec, order: number): TaskWithAssignments {
    return {
      id: spec.id,
      title: `task-${spec.id}`,
      description: null,
      deadline: new Date('2030-01-01T10:00:00.000Z'),
      status: TaskStatus.IN_PROGRESS,
      adminReviewed: false,
      messageCount: 0,
      // Убывающие даты создания для детерминированной сортировки (новые → старые).
      createdAt: new Date(Date.UTC(2030, 0, 1) - order * 1000),
      doneAt: null,
      updatedAt: new Date('2029-12-01T00:00:00.000Z'),
      assignments: spec.assignments.map((a, i) => ({
        id: `${spec.id}-a${i}`,
        taskId: spec.id,
        userId: a.userId,
        kind: a.kind,
      })),
    } as unknown as TaskWithAssignments;
  }

  /**
   * Строит сервис со stateful in-memory моками для конкретного сценария.
   * `list` фильтрует по условию видимости и применяет пагинацию (skip/take),
   * сохраняя сортировку «новые → старые».
   */
  function buildService(scenario: Scenario) {
    const usersById = new Map(scenario.users.map((u) => [u.id, u]));
    const tasks = scenario.tasks.map((spec, i) => toTaskWithAssignments(spec, i));

    const userRepository = {
      findActiveById: jest.fn(async (id: string) => {
        const u = usersById.get(id);
        return u === undefined
          ? null
          : ({ id: u.id, role: u.role, isActive: true, deletedAt: null } as unknown as User);
      }),
    } as unknown as UserRepository;

    const taskRepository = {
      list: jest.fn(async (pagination: PaginationQueryDto, where: Prisma.TaskWhereInput) => {
        const matched = tasks
          .filter((t) => matchesWhere(t, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const pageItems = matched.slice(pagination.skip, pagination.skip + pagination.take);
        return {
          items: pageItems as unknown as Task[],
          meta: {
            page: pagination.page,
            pageSize: pagination.pageSize,
            total: matched.length,
            totalPages: Math.max(1, Math.ceil(matched.length / pagination.pageSize)),
            hasNext: pagination.skip + pagination.take < matched.length,
            hasPrevious: pagination.page > PAGINATION.minPage,
          },
        };
      }),
    } as unknown as TaskRepository;

    const config = {
      limits: { maxAssigneesPerTask: 100 },
    } as unknown as AppConfigService;

    // listVisible не использует MessageRepository; передаётся пустой мок, чтобы
    // удовлетворить сигнатуру конструктора.
    const messageRepository = {} as unknown as MessageRepository;

    return new TasksService(
      taskRepository,
      userRepository,
      config,
      messageRepository,
      { record: async () => undefined },
      { enqueueTaskUpdated: async () => undefined },
    );
  }

  /**
   * Эталон: множество идентификаторов Задач, которые должны быть видимы
   * Пользователю с ролью `role` (Req 2.8–2.10).
   */
  function expectedVisibleIds(scenario: Scenario, userId: string, role: Role): Set<string> {
    if (role === Role.ADMIN) {
      return new Set(scenario.tasks.map((t) => t.id)); // все Задачи (Req 2.10)
    }
    return new Set(
      scenario.tasks.filter((t) => t.assignments.some((a) => a.userId === userId)).map((t) => t.id),
    );
  }

  /**
   * Собирает ПОЛНЫЙ набор видимых Пользователю Задач, проходя по всем страницам
   * (размер страницы максимальный, число Задач ограничено сверху, поэтому
   * обычно достаточно одной страницы; постраничный обход делает проверку
   * устойчивой к границам пагинации).
   */
  async function collectVisibleIds(service: TasksService, userId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    let page = 1;
    for (;;) {
      const query = new PaginationQueryDto();
      query.page = page;
      query.pageSize = PAGINATION.maxPageSize;
      const result = await service.listVisible(userId, query);
      for (const t of result.items) {
        ids.add(t.id);
      }
      if (!result.meta.hasNext) {
        break;
      }
      page += 1;
    }
    return ids;
  }

  // --- Генераторы сценария ---

  const roleArb: fc.Arbitrary<Role> = fc.constantFrom(Role.ADMIN, Role.MANAGER, Role.EXECUTOR);

  /** Сценарий: 1..6 уникальных Пользователей и 0..40 Задач с назначениями. */
  const scenarioArb: fc.Arbitrary<Scenario> = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 6 })
    .chain((userIds) => {
      const userIdArb = fc.constantFrom(...userIds);
      const users = fc.record({
        list: fc.constant(userIds),
        roles: fc.array(roleArb, { minLength: userIds.length, maxLength: userIds.length }),
      });
      // Назначение: любой из существующих Пользователей в роли Исполнителя или Менеджера.
      const assignmentArb: fc.Arbitrary<AssignmentSpec> = fc.record({
        userId: userIdArb,
        kind: fc.constantFrom(AssignmentKind.EXECUTOR, AssignmentKind.MANAGER),
      });
      const tasksArb = fc.array(fc.array(assignmentArb, { minLength: 0, maxLength: 6 }), {
        minLength: 0,
        maxLength: 40,
      });
      return fc.record({ users, tasks: tasksArb }).map(({ users: u, tasks }) => ({
        users: u.list.map((id, i) => ({ id, role: u.roles[i] ?? Role.EXECUTOR })),
        tasks: tasks.map((assignments, i) => ({ id: `task-${i}`, assignments })),
      }));
    });

  it('видимый набор Задач равен строго: исполнитель→его, менеджер→его, администратор→все', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const service = buildService(scenario);

        for (const user of scenario.users) {
          const actual = await collectVisibleIds(service, user.id);
          const expected = expectedVisibleIds(scenario, user.id, user.role);

          // Множества должны совпадать ТОЧНО (ни лишних, ни недостающих Задач).
          expect([...actual].sort()).toEqual([...expected].sort());
        }
      }),
      { numRuns: 200 },
    );
  });
});
