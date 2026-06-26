import fc from 'fast-check';
import { AssignmentKind, Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { AppConfigService } from '../config';
import { TaskRepository, UserRepository } from '../repositories';
import { PrismaService } from '../infra';
import { AuthService } from '../auth/auth.service';
import { AvatarStorage } from './avatar-storage';
import { UsersService } from './users.service';

/**
 * **Feature: task-assignment-system, Property 21: Переназначение осиротевших задач при удалении**
 *
 * Property 21 (см. design.md «Correctness Properties») — **Validates: Requirements 8.5**:
 *
 * Для любого удаляемого пользователя каждая задача, в которой он был
 * ЕДИНСТВЕННЫМ исполнителем или ЕДИНСТВЕННЫМ менеджером, после удаления имеет
 * статус «Требует администратора» (`NEEDS_ADMIN`); ни одна задача не остаётся
 * без исполнителя или без менеджера в активном статусе, а статусы всех
 * остальных задач остаются неизменными.
 *
 * Тест реализует РОВНО ОДНО свойство. Чтобы проверка была достоверной,
 * используется НАСТОЯЩИЙ {@link TaskRepository} (реальная логика выявления
 * осиротевших задач `findTaskIdsWhereUserIsSoleAssignee` и установки статуса
 * `setStatus`), подключённый к stateful in-memory мок-клиенту Prisma
 * (хранилища задач и назначений). {@link UserRepository}, {@link AuthService} и
 * прочие зависимости подменены мок-объектами — обращений к реальной базе нет.
 * Минимум 100 итераций fast-check (здесь — 200).
 */
describe('Property 21: Переназначение осиротевших задач при удалении (Req 8.5)', () => {
  /** Идентификаторы пользователей, из которых формируются назначения. */
  const VICTIM = 'victim';
  const ADMIN = 'admin';
  const OTHER_USERS = ['a', 'b', 'c'];
  const USER_POOL = [VICTIM, ...OTHER_USERS];

  const ALL_STATUSES: TaskStatus[] = [
    TaskStatus.IN_PROGRESS,
    TaskStatus.WAITING,
    TaskStatus.DONE,
    TaskStatus.NEEDS_ADMIN,
    TaskStatus.CANCELLED,
  ];

  /** Активные статусы, в которых задача обязана иметь исполнителя и менеджера. */
  const ACTIVE_STATUSES = new Set<TaskStatus>([TaskStatus.IN_PROGRESS, TaskStatus.WAITING]);

  interface TaskSpec {
    status: TaskStatus;
    executors: string[];
    managers: string[];
  }

  /** Непустое подмножество пула пользователей (Req 9: исполнителей/менеджеров ≥1). */
  const nonEmptySubset = fc.subarray(USER_POOL, { minLength: 1 }).filter((arr) => arr.length >= 1);

  /**
   * Спецификация задачи: начальный статус и непустые множества исполнителей и
   * менеджеров (множества независимы, один пользователь может быть и тем и
   * другим — что соответствует назначению менеджера исполнителем).
   */
  const taskSpec: fc.Arbitrary<TaskSpec> = fc.record({
    status: fc.constantFrom(...ALL_STATUSES),
    executors: nonEmptySubset,
    managers: nonEmptySubset,
  });

  const makeUser = (partial: Partial<User> & { id: string; role: Role }): User =>
    ({
      email: `${partial.id}@example.com`,
      displayName: partial.id,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
      ...partial,
    }) as unknown as User;

  /**
   * Эталонный «оракул» Property 21: задача осиротеет при удалении `VICTIM`
   * тогда и только тогда, когда он — единственный исполнитель ИЛИ единственный
   * менеджер этой задачи.
   */
  const isOrphaned = (t: TaskSpec): boolean => {
    const soleExecutor = t.executors.includes(VICTIM) && t.executors.length === 1;
    const soleManager = t.managers.includes(VICTIM) && t.managers.length === 1;
    return soleExecutor || soleManager;
  };

  /**
   * Строит окружение: stateful in-memory мок-клиент Prisma (хранилища задач и
   * назначений), настоящий {@link TaskRepository} поверх него и мок
   * {@link UserRepository}. Возвращает сервис и доступ к хранилищу задач.
   */
  const buildEnv = (tasks: TaskSpec[]) => {
    const taskStore = new Map<string, { id: string; status: TaskStatus }>();
    const assignments: { id: string; taskId: string; userId: string; kind: AssignmentKind }[] = [];

    let aid = 0;
    tasks.forEach((t, i) => {
      const id = `t${i}`;
      taskStore.set(id, { id, status: t.status });
      for (const u of t.executors) {
        assignments.push({
          id: `as${aid++}`,
          taskId: id,
          userId: u,
          kind: AssignmentKind.EXECUTOR,
        });
      }
      for (const u of t.managers) {
        assignments.push({ id: `as${aid++}`, taskId: id, userId: u, kind: AssignmentKind.MANAGER });
      }
    });

    // Stateful in-memory клиент Prisma: только методы, используемые
    // TaskRepository.findTaskIdsWhereUserIsSoleAssignee и setStatus.
    const prismaClient = {
      taskAssignment: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          assignments
            .filter((a) => a.userId === where.userId)
            .map((a) => ({ taskId: a.taskId, kind: a.kind })),
        groupBy: async ({ where }: { where: { taskId: { in: string[] } } }) => {
          const ids = where.taskId.in;
          const counts = new Map<string, number>();
          for (const a of assignments) {
            if (!ids.includes(a.taskId)) continue;
            const key = `${a.taskId}|${a.kind}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return [...counts.entries()].map(([key, count]) => {
            const [taskId, kind] = key.split('|');
            return { taskId, kind: kind as AssignmentKind, _count: { _all: count } };
          });
        },
      },
      task: {
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status: TaskStatus };
        }) => {
          const task = taskStore.get(where.id);
          if (task === undefined) {
            throw new Error(`Задача «${where.id}» не найдена в in-memory хранилище.`);
          }
          task.status = data.status;
          return { ...task };
        },
      },
    };

    // Настоящий репозиторий задач поверх in-memory клиента Prisma.
    const taskRepository = new TaskRepository(prismaClient as unknown as PrismaService);

    // Мок репозитория пользователей: транзакция передаёт тот же in-memory
    // клиент Prisma, что позволяет TaskRepository работать «внутри транзакции».
    const userStore = new Map<string, User>([
      [ADMIN, makeUser({ id: ADMIN, role: Role.ADMIN })],
      [VICTIM, makeUser({ id: VICTIM, role: Role.EXECUTOR })],
    ]);
    const userRepository = {
      runInTransaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(prismaClient),
      findActiveById: async (id: string) => {
        const u = userStore.get(id);
        return u !== undefined && u.isActive && u.deletedAt === null ? u : null;
      },
      update: async (id: string, data: Partial<User>) => {
        const u = userStore.get(id);
        if (u !== undefined) Object.assign(u, data);
        return u as User;
      },
      delete: async (id: string) => {
        userStore.delete(id);
      },
    } as unknown as UserRepository;

    const auth = { revokeAllSessions: jest.fn(async () => 0) } as unknown as AuthService;
    const mailer = { enqueue: jest.fn() } as unknown as MailerService;
    const clock = { now: () => new Date('2024-01-01T00:00:00Z') } as unknown as ClockService;
    const config = {
      limits: { avatarMaxBytes: 5 * 1024 * 1024 },
    } as unknown as AppConfigService;
    const avatarStorage = { store: jest.fn() } as unknown as AvatarStorage;

    const service = new UsersService(
      userRepository,
      taskRepository,
      auth,
      mailer,
      clock,
      config,
      avatarStorage,
    );

    return { service, taskStore };
  };

  it('переводит в «Требует администратора» РОВНО осиротевшие задачи, прочие статусы неизменны', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(taskSpec, { minLength: 0, maxLength: 12 }),
        fc.constantFrom<'soft' | 'hard'>('soft', 'hard'),
        async (tasks, mode) => {
          const { service, taskStore } = buildEnv(tasks);
          const initialStatuses = tasks.map((t) => t.status);

          await service.deleteUser(ADMIN, VICTIM, mode);

          tasks.forEach((spec, i) => {
            const id = `t${i}`;
            const finalStatus = taskStore.get(id)!.status;

            if (isOrphaned(spec)) {
              // Осиротевшая задача получает статус «Требует администратора» (Req 8.5).
              expect(finalStatus).toBe(TaskStatus.NEEDS_ADMIN);
            } else {
              // Не осиротевшая задача сохраняет исходный статус без изменений.
              expect(finalStatus).toBe(initialStatuses[i]);
            }

            // Ни одна задача не остаётся без исполнителя или без менеджера в
            // активном статусе: после удаления VICTIM из назначений активный
            // статус возможен только при наличии и исполнителя, и менеджера.
            if (ACTIVE_STATUSES.has(finalStatus)) {
              const execLeft = spec.executors.filter((u) => u !== VICTIM);
              const mgrLeft = spec.managers.filter((u) => u !== VICTIM);
              expect(execLeft.length).toBeGreaterThanOrEqual(1);
              expect(mgrLeft.length).toBeGreaterThanOrEqual(1);
            }
          });
        },
      ),
      { numRuns: 200 },
    );
  });
});
