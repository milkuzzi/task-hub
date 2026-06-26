import fc from 'fast-check';
import { AssignmentKind, Role, Task, TaskStatus, User } from '@prisma/client';
import { AccessDeniedException } from '../common/errors';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { AssignmentDto } from './dto';
import { TasksService } from './tasks.service';

/**
 * **Feature: task-assignment-system, Property 8: Правила назначения исполнителей**
 *
 * Property 8 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 2.4, 2.5, 2.6, 2.7**:
 *
 * Для любой Задачи и любых актора и кандидата:
 * - назначение Менеджера Исполнителем разрешено ТОЛЬКО Администратору (Req 2.5);
 * - попытка Менеджера назначить Менеджера Исполнителем отклоняется и оставляет
 *   состав Исполнителей Задачи без изменений (Req 2.6);
 * - Менеджер, назначенный Исполнителем, получает права Исполнителя и НЕ может
 *   редактировать эту Задачу (Req 2.4);
 * - при нескольких Менеджерах Задачи все они обладают равными правами и правка
 *   любого из них применяется без согласования (Req 2.7).
 *
 * Границы БД ({@link TaskRepository}, {@link UserRepository}) подменяются
 * детерминированными СОСТОЯНИЕВЫМИ in-memory моками с тем же контрактом:
 * `findActiveById`/`findManyActiveByIds` возвращают активных Пользователей с
 * заданными ролями; `findByIdWithAssignments` отдаёт текущий снимок назначений
 * Задачи; `replaceAssignments` атомарно перезаписывает назначения во
 * внутреннем состоянии. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */
describe('Property 8: Правила назначения исполнителей (Req 2.4, 2.5, 2.6, 2.7)', () => {
  const LIMITS = {
    taskTitleMaxLength: 200,
    taskDescriptionMaxLength: 5000,
    maxAssigneesPerTask: 100,
  };

  const TASK_ID = 'task-1';
  const ADMIN_ID = 'admin';
  const CANDIDATE_MANAGER_ID = 'mgr-cand';

  /** Создаёт User-подобную запись с минимально необходимыми полями. */
  function makeUser(id: string, role: Role): User {
    return {
      id,
      email: `${id}@example.com`,
      displayName: id,
      role,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
    } as unknown as User;
  }

  /**
   * Строит изолированный СОСТОЯНИЕВЫЙ мир: пользователи с ролями, одна Задача с
   * заданным составом Менеджеров-назначенцев и Исполнителей-назначенцев, и
   * {@link TasksService} поверх in-memory репозиториев.
   */
  function makeWorld(taskManagerCount: number, executorCount: number) {
    const users = new Map<string, User>();
    users.set(ADMIN_ID, makeUser(ADMIN_ID, Role.ADMIN));
    // Кандидат-Менеджер НЕ назначен Менеджером Задачи: он используется как
    // кандидат в Исполнители и как Менеджер, назначенный Исполнителем.
    users.set(CANDIDATE_MANAGER_ID, makeUser(CANDIDATE_MANAGER_ID, Role.MANAGER));

    const taskManagerIds: string[] = [];
    for (let i = 0; i < taskManagerCount; i += 1) {
      const id = `mgr-${i}`;
      users.set(id, makeUser(id, Role.MANAGER));
      taskManagerIds.push(id);
    }

    const executorIds: string[] = [];
    for (let i = 0; i < executorCount; i += 1) {
      const id = `exec-${i}`;
      users.set(id, makeUser(id, Role.EXECUTOR));
      executorIds.push(id);
    }

    // Текущее состояние назначений Задачи (мутируется replaceAssignments).
    let assignments = [
      ...executorIds.map((userId) => ({ userId, kind: AssignmentKind.EXECUTOR })),
      ...taskManagerIds.map((userId) => ({ userId, kind: AssignmentKind.MANAGER })),
    ];

    const taskBase = {
      id: TASK_ID,
      title: 'Задача',
      description: null,
      deadline: new Date('2030-01-01T00:00:00Z'),
      status: TaskStatus.IN_PROGRESS,
      adminReviewed: false,
      messageCount: 0,
      createdAt: new Date('2030-01-01T00:00:00Z'),
      doneAt: null,
      updatedAt: new Date('2030-01-01T00:00:00Z'),
    } as unknown as Task;

    const snapshot = (): TaskWithAssignments =>
      ({
        ...taskBase,
        assignments: assignments.map((a, idx) => ({
          id: `as-${idx}`,
          taskId: TASK_ID,
          userId: a.userId,
          kind: a.kind,
        })),
      }) as unknown as TaskWithAssignments;

    const userRepository = {
      findActiveById: jest.fn(async (id: string) => {
        const u = users.get(id);
        return u && u.isActive ? u : null;
      }),
      findManyActiveByIds: jest.fn(async (ids: string[]) =>
        ids.map((id) => users.get(id)).filter((u): u is User => u !== undefined && u.isActive),
      ),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) => (id === TASK_ID ? snapshot() : null)),
      replaceAssignments: jest.fn(
        async (taskId: string, nextExecutors: string[], nextManagers: string[]) => {
          if (taskId !== TASK_ID) {
            throw new Error('unexpected task id');
          }
          assignments = [
            ...nextExecutors.map((userId) => ({ userId, kind: AssignmentKind.EXECUTOR })),
            ...nextManagers.map((userId) => ({ userId, kind: AssignmentKind.MANAGER })),
          ];
          return snapshot();
        },
      ),
    } as unknown as TaskRepository;

    const config = { limits: LIMITS } as unknown as AppConfigService;
    const messageRepository = {} as unknown as MessageRepository;
    const service = new TasksService(
      taskRepository,
      userRepository,
      config,
      messageRepository,
      { record: async () => undefined },
      { enqueueTaskUpdated: async () => undefined },
    );

    const currentExecutorSet = (): Set<string> =>
      new Set(assignments.filter((a) => a.kind === AssignmentKind.EXECUTOR).map((a) => a.userId));

    return { service, taskManagerIds, executorIds, currentExecutorSet };
  }

  const specArb = fc.record({
    taskManagerCount: fc.integer({ min: 1, max: 3 }),
    executorCount: fc.integer({ min: 1, max: 4 }),
  });

  it('Менеджер-исполнителя назначает только Администратор; попытка Менеджера отклоняется без изменений; назначенный Менеджер получает права Исполнителя и не редактирует', async () => {
    await fc.assert(
      fc.asyncProperty(specArb, async ({ taskManagerCount, executorCount }) => {
        // --- (Req 2.6) Менеджер Задачи НЕ может назначить Менеджера Исполнителем;
        //     состав Исполнителей остаётся без изменений. -----------------------
        {
          const { service, taskManagerIds, executorIds, currentExecutorSet } = makeWorld(
            taskManagerCount,
            executorCount,
          );
          const before = currentExecutorSet();
          const actorManager = taskManagerIds[0]!;
          const dto: AssignmentDto = {
            // Пытаемся добавить кандидата-Менеджера в Исполнители.
            executorIds: [...executorIds, CANDIDATE_MANAGER_ID],
            managerIds: taskManagerIds,
          };
          await expect(service.assign(actorManager, TASK_ID, dto)).rejects.toBeInstanceOf(
            AccessDeniedException,
          );
          // Состав Исполнителей не изменился (Req 2.6).
          const after = currentExecutorSet();
          expect([...after].sort()).toEqual([...before].sort());
          expect(after.has(CANDIDATE_MANAGER_ID)).toBe(false);
        }

        // --- (Req 2.5) Администратор МОЖЕТ назначить Менеджера Исполнителем. ----
        {
          const { service, taskManagerIds, executorIds, currentExecutorSet } = makeWorld(
            taskManagerCount,
            executorCount,
          );
          const dto: AssignmentDto = {
            executorIds: [...executorIds, CANDIDATE_MANAGER_ID],
            managerIds: taskManagerIds,
          };
          const updated = await service.assign(ADMIN_ID, TASK_ID, dto);
          // Назначение применено: кандидат-Менеджер теперь Исполнитель.
          expect(currentExecutorSet().has(CANDIDATE_MANAGER_ID)).toBe(true);
          const execAssignees = updated.assignments
            .filter((a) => a.kind === AssignmentKind.EXECUTOR)
            .map((a) => a.userId);
          expect(execAssignees).toContain(CANDIDATE_MANAGER_ID);
        }

        // --- (Req 2.4) Менеджер, назначенный Исполнителем, получает права
        //     Исполнителя (видит Задачу) и НЕ может её редактировать. -----------
        {
          const { service, taskManagerIds, executorIds } = makeWorld(
            taskManagerCount,
            executorCount,
          );
          // Администратор назначает кандидата-Менеджера Исполнителем.
          await service.assign(ADMIN_ID, TASK_ID, {
            executorIds: [...executorIds, CANDIDATE_MANAGER_ID],
            managerIds: taskManagerIds,
          });
          // Права Исполнителя: Задача видима назначенному Менеджеру (Req 2.4, 2.8).
          const visible = await service.getVisibleTask(CANDIDATE_MANAGER_ID, TASK_ID);
          expect(visible.id).toBe(TASK_ID);
          // Не может редактировать состав участников Задачи (Req 2.4).
          await expect(
            service.assign(CANDIDATE_MANAGER_ID, TASK_ID, {
              executorIds,
              managerIds: taskManagerIds,
            }),
          ).rejects.toBeInstanceOf(AccessDeniedException);
        }

        // --- (Req 2.7) Несколько Менеджеров Задачи обладают равными правами:
        //     допустимую правку (только Исполнители) применяет любой из них. ----
        {
          const { service, taskManagerIds, executorIds, currentExecutorSet } = makeWorld(
            taskManagerCount,
            executorCount,
          );
          const reduced = executorIds.slice(0, Math.max(1, executorIds.length - 1));
          for (const managerId of taskManagerIds) {
            const updated = await service.assign(managerId, TASK_ID, {
              executorIds: reduced,
              managerIds: taskManagerIds,
            });
            expect(updated.id).toBe(TASK_ID);
            // Правка применена без согласования с другими Менеджерами.
            expect([...currentExecutorSet()].sort()).toEqual([...new Set(reduced)].sort());
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
