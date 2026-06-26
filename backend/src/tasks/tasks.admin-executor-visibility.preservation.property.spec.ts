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
 * **Feature: task-hub-bug-fixes — Дефект 7, Property 14: Видимость для ADMIN и назначенных Пользователей**
 *
 * Preservation тест — **Validates: Requirements 3.7**.
 *
 * Свойство фиксирует поведение, которое НЕ должно меняться при исправлении
 * дефекта 7. Ветка ADMIN остаётся без ограничений, а не-админская видимость
 * теперь определяется фактом назначения Пользователя на Задачу.
 *
 * Property 14 (целевое сохраняемое поведение):
 *   - для запроса списка Задач Пользователем с ролью ADMIN выдача SHALL
 *     содержать ВСЕ Задачи;
 *   - для запроса списка Задач Пользователем с ролью EXECUTOR выдача SHALL
 *     содержать РОВНО те Задачи, где он назначен в любом виде.
 *
 * **IMPORTANT (методология «сначала наблюдение»)**: тест запускается на
 * НЕИСПРАВЛЕННОМ коде и ДОЛЖЕН ПРОХОДИТЬ — он фиксирует наблюдаемую видимость
 * для ADMIN/EXECUTOR, чтобы после фикса MANAGER подтвердить отсутствие
 * регрессий (задача 21.3).
 *
 * Тест реализует РОВНО ОДНО свойство (Property 14). Внешние границы
 * ({@link TaskRepository}, {@link UserRepository}, {@link AppConfigService})
 * подменяются stateful in-memory моками — обращений к реальной БД/Redis нет.
 * Мок-репозиторий честно интерпретирует то же условие видимости, что строит
 * сервис (включая форму `kind: { in: [...] }`), и реализует пагинацию; таким
 * образом проверяется именно предикат видимости, формируемый сервисом через
 * публичный путь {@link TasksService.listVisible}.
 */
describe('Property 14: Видимость для ADMIN и назначенного EXECUTOR (Preservation, Req 3.7)', () => {
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
   * `TasksService.buildVisibilityWhere`. Поддерживает как одиночный `kind`,
   * так и `kind: { in: [...] }` (форма после фикса), чтобы тот же тест мог
   * пройти как до, так и после исправления.
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
   * Строит сервис со stateful in-memory моками: один Пользователь-наблюдатель с
   * заданной ролью и набор Задач. `list` фильтрует по условию видимости и
   * применяет пагинацию, сохраняя сортировку «новые → старые».
   */
  function buildService(viewerId: string, viewerRole: Role, taskSpecs: TaskSpec[]) {
    const tasks = taskSpecs.map((spec, i) => toTaskWithAssignments(spec, i));

    const userRepository = {
      findActiveById: jest.fn(async (id: string) =>
        id === viewerId
          ? ({ id, role: viewerRole, isActive: true, deletedAt: null } as unknown as User)
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

  const VIEWER_ID = 'viewer-user';
  const OTHER_ID = 'other-user';

  /**
   * Сценарий: набор Задач, в каждой из которых произвольный состав назначений.
   * Наблюдатель ({@link VIEWER_ID}) может быть назначен MANAGER, EXECUTOR, либо
   * вовсе не назначен; присутствует и посторонний Пользователь
   * ({@link OTHER_ID}). Это покрывает домен ролей/назначений для проверки
   * видимости ADMIN/EXECUTOR.
   */
  const scenarioArb: fc.Arbitrary<TaskSpec[]> = fc
    .array(
      fc
        .array(
          fc.record({
            userId: fc.constantFrom(VIEWER_ID, OTHER_ID),
            kind: fc.constantFrom(AssignmentKind.MANAGER, AssignmentKind.EXECUTOR),
          }),
          { minLength: 0, maxLength: 4 },
        )
        .map((assignments) => assignments),
      { minLength: 0, maxLength: 20 },
    )
    .map((perTask) =>
      perTask.map((assignments, i) => ({
        id: `task-${i}`,
        assignments,
      })),
    );

  it('ADMIN видит ВСЕ Задачи независимо от назначений', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (taskSpecs) => {
        const service = buildService(VIEWER_ID, Role.ADMIN, taskSpecs);

        const visible = await collectVisibleIds(service, VIEWER_ID);

        // Property 14 (ADMIN): видны все Задачи.
        const expected = new Set(taskSpecs.map((t) => t.id));

        expect([...visible].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 200 },
    );
  });

  it('EXECUTOR видит РОВНО Задачи, где он назначен в любом виде', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (taskSpecs) => {
        const service = buildService(VIEWER_ID, Role.EXECUTOR, taskSpecs);

        const visible = await collectVisibleIds(service, VIEWER_ID);

        // Property 14 (EXECUTOR): список совпадает с прямым доступом к Задаче
        // из уведомления — видны все Задачи, где наблюдатель назначен.
        const expected = new Set(
          taskSpecs
            .filter((t) => t.assignments.some((a) => a.userId === VIEWER_ID))
            .map((t) => t.id),
        );

        expect([...visible].sort()).toEqual([...expected].sort());
      }),
      { numRuns: 200 },
    );
  });
});
