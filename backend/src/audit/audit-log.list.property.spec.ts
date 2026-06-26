import fc from 'fast-check';
import { AssignmentKind, AuditEntry, Role, TaskStatus, User } from '@prisma/client';
import { ClockService } from '../clock';
import { AccessDeniedException } from '../common/errors';
import { TaskRepository, TaskWithAssignments, UserRepository } from '../repositories';
import { AuditEntryRepository } from './audit-entry.repository';
import { AuditLogService } from './audit-log.service';

/**
 * **Feature: task-assignment-system, Property 57: Журнал изменений — порядок и права просмотра**
 *
 * Property 57 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 20.2, 20.3**:
 *
 * Для любой Задачи при просмотре Журнала изменений Менеджером этой Задачи или
 * Администратором возвращаются ВСЕ записи именно этой Задачи, упорядоченные по
 * времени изменения строго от новых к старым (Req 20.2); Пользователю без прав
 * — Исполнителю Задачи, Менеджеру, назначенному на неё Исполнителем, и любому
 * не назначенному на Задачу Пользователю — доступ отклоняется (Req 20.3).
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Внешние границы
 * ({@link AuditEntryRepository}, {@link TaskRepository}, {@link UserRepository})
 * подменяются СТАТЕФУЛ in-memory моками поверх общего хранилища, а время
 * инъецируется через {@link ClockService} — обращений к реальной БД/Redis нет.
 *
 * Порядок проверяется честно: in-memory {@link AuditEntryRepository} хранит
 * записи в ПРОИЗВОЛЬНОМ порядке и сортирует их «новые → старые» по `changedAt`
 * при чтении (как и реальный Prisma-запрос `orderBy: { changedAt: 'desc' }`),
 * после чего свойство утверждает строгую монотонную убываемость времён в
 * результате сервиса и полноту набора записей именно целевой Задачи.
 */
describe('Property 57: Журнал изменений — порядок и права просмотра (Req 20.2, 20.3)', () => {
  const ACTOR_ID = 'actor';
  const TARGET_TASK_ID = 't1';
  const OTHER_TASK_ID = 't2';
  const BASE_MS = Date.parse('2030-01-01T00:00:00.000Z');
  const FIXED_NOW = new Date('2030-06-15T09:00:00.000Z');

  /** Отношение инициатора к Задаче: не назначен / Исполнитель / Менеджер. */
  type ActorAssignment = 'none' | AssignmentKind;

  interface Store {
    users: Map<string, User>;
    tasks: Map<string, TaskWithAssignments>;
    /** Записи Журнала в ПРОИЗВОЛЬНОМ порядке (как «сырое» хранилище). */
    entries: AuditEntry[];
  }

  /**
   * Строит сервис поверх статэфул моков. {@link AuditEntryRepository}
   * фильтрует по `taskId` и сортирует «новые → старые», имитируя Prisma.
   */
  function buildService(store: Store): AuditLogService {
    const auditEntryRepository = {
      listByTaskNewestFirst: jest.fn(async (taskId: string) =>
        store.entries
          .filter((e) => e.taskId === taskId)
          .slice()
          .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime()),
      ),
      create: jest.fn(),
    } as unknown as AuditEntryRepository;

    const userRepository = {
      findActiveById: jest.fn(async (id: string) => store.users.get(id) ?? null),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) => store.tasks.get(id) ?? null),
    } as unknown as TaskRepository;

    const clock = new ClockService({ now: () => FIXED_NOW });

    return new AuditLogService(auditEntryRepository, taskRepository, userRepository, clock);
  }

  // --- Арбитрари ---

  /** Глобальная роль инициатора. */
  const actorRoleArb = fc.constantFrom<Role>(Role.EXECUTOR, Role.MANAGER, Role.ADMIN);

  /** Назначение инициатора на Задачу. */
  const actorAssignmentArb = fc.constantFrom<ActorAssignment>(
    'none',
    AssignmentKind.EXECUTOR,
    AssignmentKind.MANAGER,
  );

  /**
   * Спецификация одной записи Журнала. Уникальный `offsetMs` гарантирует
   * различные времена `changedAt` — это делает порядок «новые → старые»
   * СТРОГИМ и проверяемым на строгую монотонность. `otherTask` помещает запись
   * в другую Задачу, проверяя фильтрацию по `taskId`.
   */
  const entrySpecArb = fc.record({
    offsetMs: fc.integer({ min: 0, max: 5_000_000 }),
    field: fc.constantFrom('title', 'description', 'deadline', 'executors', 'managers', 'status'),
    oldValue: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
    newValue: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
    otherTask: fc.boolean(),
  });

  const entrySpecsArb = fc.uniqueArray(entrySpecArb, {
    selector: (e) => e.offsetMs,
    minLength: 0,
    maxLength: 14,
  });

  it('менеджеру задачи/администратору отдаёт все записи задачи строго от новых к старым, прочим — отказывает', async () => {
    await fc.assert(
      fc.asyncProperty(
        actorRoleArb,
        actorAssignmentArb,
        entrySpecsArb,
        async (role, actorAssignment, entrySpecs) => {
          const store: Store = { users: new Map(), tasks: new Map(), entries: [] };

          // Активный инициатор с заданной глобальной ролью.
          store.users.set(ACTOR_ID, {
            id: ACTOR_ID,
            role,
            isActive: true,
            deletedAt: null,
          } as unknown as User);

          // Назначения целевой Задачи: инициатор (если назначен) + посторонние
          // Менеджер и Исполнитель (чтобы наличие другого Менеджера не давало
          // прав инициатору).
          const assignments: Array<{ userId: string; kind: AssignmentKind }> = [
            { userId: 'foreign-mgr', kind: AssignmentKind.MANAGER },
            { userId: 'foreign-exe', kind: AssignmentKind.EXECUTOR },
          ];
          if (actorAssignment !== 'none') {
            assignments.push({ userId: ACTOR_ID, kind: actorAssignment });
          }

          const buildTask = (id: string): TaskWithAssignments =>
            ({
              id,
              title: `task-${id}`,
              description: null,
              deadline: new Date('2030-02-01T10:00:00.000Z'),
              status: TaskStatus.IN_PROGRESS,
              messageCount: 0,
              createdAt: new Date('2029-12-01T00:00:00.000Z'),
              updatedAt: new Date('2029-12-01T00:00:00.000Z'),
              assignments: assignments.map((a, i) => ({
                id: `${id}-a${i}`,
                taskId: id,
                userId: a.userId,
                kind: a.kind,
              })),
            }) as unknown as TaskWithAssignments;

          store.tasks.set(TARGET_TASK_ID, buildTask(TARGET_TASK_ID));
          store.tasks.set(OTHER_TASK_ID, buildTask(OTHER_TASK_ID));

          // Заполняем «сырое» хранилище записей в произвольном порядке.
          store.entries = entrySpecs.map((spec, i) => {
            const taskId = spec.otherTask ? OTHER_TASK_ID : TARGET_TASK_ID;
            return {
              id: `e${i}`,
              taskId,
              authorId: 'foreign-mgr',
              field: spec.field,
              oldValue: spec.oldValue,
              newValue: spec.newValue,
              changedAt: new Date(BASE_MS + spec.offsetMs),
            } as unknown as AuditEntry;
          });

          const service = buildService(store);
          const clock = new ClockService({ now: () => FIXED_NOW });

          const expectedAccess = role === Role.ADMIN || actorAssignment === AssignmentKind.MANAGER;

          // Ожидаемый набор: только записи целевой Задачи, новые → старые.
          const expected = store.entries
            .filter((e) => e.taskId === TARGET_TASK_ID)
            .slice()
            .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());

          if (expectedAccess) {
            const result = await service.list(ACTOR_ID, TARGET_TASK_ID);

            // Полнота: ровно записи целевой Задачи (других Задач — нет).
            expect(result.map((e) => e.id)).toEqual(expected.map((e) => e.id));
            expect(result.every((e) => e.taskId === TARGET_TASK_ID)).toBe(true);

            // Порядок: строго от новых к старым (времена строго убывают).
            for (let i = 1; i < result.length; i += 1) {
              expect(result[i - 1]!.changedAt.getTime()).toBeGreaterThan(
                result[i]!.changedAt.getTime(),
              );
            }

            // Представление времени в MSK сопровождает каждую запись (Req 20.1).
            for (const entry of result) {
              expect(entry.changedAtMsk).toBe(clock.formatMsk(entry.changedAt));
            }
          } else {
            // Пользователю без прав доступ отклоняется (Req 20.3).
            await expect(service.list(ACTOR_ID, TARGET_TASK_ID)).rejects.toBeInstanceOf(
              AccessDeniedException,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
