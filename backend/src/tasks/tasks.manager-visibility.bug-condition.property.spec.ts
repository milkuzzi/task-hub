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
 * **Feature: task-hub-bug-fixes — Дефект 7, Property 13: Видимость Задач для роли MANAGER**
 *
 * Exploratory (Bug Condition) тест — **Validates: Requirements 1.7, 2.7**.
 *
 * Условие дефекта `isBugCondition_7`:
 *   role == MANAGER
 *   AND существует Задача T, где Пользователь назначен EXECUTOR (исполнителем),
 *       но НЕ назначен MANAGER
 *   AND T отсутствует в выдаче списка Задач.
 *
 * Property 13 (целевое корректное поведение): для запроса списка Задач
 * Пользователем с ролью MANAGER выдача SHALL содержать Задачи, где Пользователь
 * назначен Менеджером ИЛИ Исполнителем.
 *
 * **CRITICAL**: Этот тест ДОЛЖЕН ПАДАТЬ на неисправленном коде. В текущем
 * `TasksService.buildVisibilityWhere` для роли MANAGER строится условие
 * `{ assignments: { some: { userId, kind: MANAGER } } }`, поэтому Задача, где
 * MANAGER назначен только Исполнителем, исключается из выдачи — падение
 * подтверждает наличие дефекта.
 *
 * Тест реализует РОВНО ОДНО свойство (Property 13). Внешние границы
 * ({@link TaskRepository}, {@link UserRepository}, {@link AppConfigService})
 * подменяются stateful in-memory моками — обращений к реальной БД/Redis нет.
 * Мок-репозиторий честно интерпретирует то же условие видимости, что строит
 * сервис (включая форму `kind: { in: [...] }`), и реализует пагинацию; таким
 * образом проверяется именно предикат видимости, формируемый сервисом через
 * публичный путь {@link TasksService.listVisible}.
 */
describe('Property 13: Видимость Задач для роли MANAGER (Bug Condition, Req 1.7, 2.7)', () => {
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

  /**
   * Честная интерпретация условия видимости из приватного
   * `TasksService.buildVisibilityWhere`. Поддерживает как одиночный `kind`
   * (текущая дефектная форма), так и `kind: { in: [...] }` (форма после фикса),
   * чтобы тот же тест мог пройти после исправления.
   */
  function matchesWhere(task: TaskWithAssignments, where: Prisma.TaskWhereInput): boolean {
    if (Object.keys(where).length === 0) {
      return true; // Администратор — все Задачи.
    }
    const some = (
      where.assignments as
        | {
            some?: {
              userId?: string;
              kind?: AssignmentKind | { in?: AssignmentKind[] };
            };
          }
        | undefined
    )?.some;
    if (some === undefined) {
      return true;
    }
    const kindMatcher = some.kind;
    return task.assignments.some((a) => {
      if (a.userId !== some.userId) {
        return false;
      }
      if (kindMatcher === undefined) {
        return true;
      }
      if (typeof kindMatcher === 'object' && kindMatcher !== null && 'in' in kindMatcher) {
        return (kindMatcher.in ?? []).includes(a.kind);
      }
      return a.kind === kindMatcher;
    });
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
   * Строит сервис со stateful in-memory моками: один Пользователь с ролью
   * MANAGER и набор Задач. `list` фильтрует по условию видимости и применяет
   * пагинацию, сохраняя сортировку «новые → старые».
   */
  function buildService(managerId: string, taskSpecs: TaskSpec[]) {
    const tasks = taskSpecs.map((spec, i) => toTaskWithAssignments(spec, i));

    const userRepository = {
      findActiveById: jest.fn(async (id: string) =>
        id === managerId
          ? ({ id, role: Role.MANAGER, isActive: true, deletedAt: null } as unknown as User)
          : null,
      ),
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

  /** Собирает ПОЛНЫЙ набор видимых Пользователю Задач, проходя по всем страницам. */
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

  const MANAGER_ID = 'manager-user';

  /**
   * Сценарий: набор Задач, в каждой из которых MANAGER-Пользователь назначен с
   * видом из {MANAGER, EXECUTOR}. Гарантируется хотя бы одна Задача, где он
   * назначен EXECUTOR (но не MANAGER), — это вход, удовлетворяющий
   * `isBugCondition_7`.
   */
  const scenarioArb: fc.Arbitrary<TaskSpec[]> = fc
    .array(fc.constantFrom(AssignmentKind.MANAGER, AssignmentKind.EXECUTOR), {
      minLength: 0,
      maxLength: 20,
    })
    .map((kinds) => {
      // Дополнительная гарантированная Задача T: MANAGER-Пользователь — EXECUTOR.
      const bugTask: TaskSpec = {
        id: 'bug-task',
        assignments: [{ userId: MANAGER_ID, kind: AssignmentKind.EXECUTOR }],
      };
      const rest: TaskSpec[] = kinds.map((kind, i) => ({
        id: `task-${i}`,
        assignments: [{ userId: MANAGER_ID, kind }],
      }));
      return [bugTask, ...rest];
    });

  it('выдача списка для MANAGER содержит Задачи, где он назначен Менеджером ИЛИ Исполнителем', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (taskSpecs) => {
        const service = buildService(MANAGER_ID, taskSpecs);

        const visible = await collectVisibleIds(service, MANAGER_ID);

        // Property 13: видимы все Задачи, где Пользователь назначен MANAGER ИЛИ EXECUTOR.
        const expected = new Set(
          taskSpecs
            .filter((t) =>
              t.assignments.some(
                (a) =>
                  a.userId === MANAGER_ID &&
                  (a.kind === AssignmentKind.MANAGER || a.kind === AssignmentKind.EXECUTOR),
              ),
            )
            .map((t) => t.id),
        );

        expect([...visible].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 200 },
    );
  });
});
