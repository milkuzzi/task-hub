import fc from 'fast-check';
import { AssignmentKind, Role, TaskStatus, User } from '@prisma/client';
import { EntityNotFoundException } from '../common/errors';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { TasksService } from './tasks.service';

/**
 * **Feature: task-assignment-system, Property 7: Отказ в доступе к чужой задаче не раскрывает содержимое**
 *
 * Property 7 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 2.12**:
 *
 * Для любого Пользователя и любой Задачи, к которой у него нет прав по роли и
 * назначениям, запрос отклоняется и не возвращает содержимое Задачи.
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Внешние границы
 * ({@link TaskRepository}, {@link UserRepository}, {@link AppConfigService})
 * подменяются СТАТЕФУЛ in-memory моками поверх общего хранилища — обращений к
 * реальной БД/Redis/конфигурации нет. `ClockService` сервису не требуется.
 *
 * Чтобы гарантировать отсутствие прав, запрашивающий Пользователь:
 * - имеет глобальную роль Исполнителя или Менеджера (не Администратор — тот
 *   видит все Задачи, Req 2.10);
 * - НЕ назначен на Задачу ни Исполнителем, ни Менеджером (его идентификатор
 *   отсутствует среди назначений).
 *
 * Содержимое Задачи (Название/Описание и прочие поля) помечается уникальными
 * «секретными» маркерами (`§…§`), которых заведомо нет в служебных сообщениях
 * Системы. Свойство утверждает: вызов отклоняется {@link EntityNotFoundException},
 * и брошенная ошибка (её сообщение, код и любое сериализованное представление)
 * не содержит ни одного секретного маркера, то есть не раскрывает содержимое.
 */
describe('Property 7: Отказ в доступе к чужой задаче не раскрывает содержимое (Req 2.12)', () => {
  const REQUESTER_ID = 'requester';

  /**
   * Статэфул in-memory хранилище Пользователей и Задач. Репозитории читают
   * исключительно из него, имитируя поведение Prisma без реальной БД.
   */
  interface Store {
    users: Map<string, User>;
    tasks: Map<string, TaskWithAssignments>;
  }

  /**
   * Строит сервис поверх статэфул моков, читающих из переданного хранилища.
   */
  function buildService(store: Store): TasksService {
    const userRepository = {
      findActiveById: jest.fn(async (id: string) => store.users.get(id) ?? null),
    } as unknown as UserRepository;

    const taskRepository = {
      findByIdWithAssignments: jest.fn(async (id: string) => store.tasks.get(id) ?? null),
    } as unknown as TaskRepository;

    const config = {
      limits: {
        taskTitleMaxLength: 200,
        taskDescriptionMaxLength: 5000,
        maxAssigneesPerTask: 100,
      },
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

  /** Собирает все строковые «следы» брошенной ошибки для проверки утечки. */
  function errorFootprint(err: unknown): string {
    const parts: string[] = [];
    if (err instanceof Error) {
      parts.push(err.message);
      parts.push(err.stack ?? '');
    }
    const candidate = err as { code?: unknown; toErrorResponse?: () => unknown };
    if (typeof candidate.code === 'string') {
      parts.push(candidate.code);
    }
    if (typeof candidate.toErrorResponse === 'function') {
      try {
        parts.push(JSON.stringify(candidate.toErrorResponse()));
      } catch {
        // игнорируем — нерелевантно для проверки утечки
      }
    }
    try {
      parts.push(JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
    } catch {
      // игнорируем
    }
    return parts.join('\u0000');
  }

  // --- Арбитрари ---

  /** Глобальная роль запрашивающего: только без прав на чужую Задачу. */
  const requesterRoleArb = fc.constantFrom<Role>(Role.EXECUTOR, Role.MANAGER);

  /** Идентификатор назначенца: заведомо НЕ совпадает с запрашивающим. */
  const otherIdArb = fc.string({ minLength: 1, maxLength: 6 }).map((s) => `other-${s}`);

  /** Назначение на Задачу (Исполнитель/Менеджер) для постороннего Пользователя. */
  const assignmentArb = fc.record({
    userId: otherIdArb,
    kind: fc.constantFrom<AssignmentKind>(AssignmentKind.EXECUTOR, AssignmentKind.MANAGER),
  });

  /** Список назначений (в т.ч. пустой — Задача без участников). */
  const assignmentsArb = fc.array(assignmentArb, { minLength: 0, maxLength: 8 });

  /** «Секретный» фрагмент содержимого с маркерами `§…§`, отсутствующими в сообщениях. */
  const secretArb = (label: string): fc.Arbitrary<string> =>
    fc.string({ minLength: 1, maxLength: 24 }).map((s) => `§${label}:${s}§`);

  const taskShapeArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `task-${s}`),
    title: secretArb('TITLE'),
    description: fc.oneof(fc.constant(null), secretArb('DESC')),
    status: fc.constantFrom<TaskStatus>(...(Object.values(TaskStatus) as TaskStatus[])),
    assignments: assignmentsArb,
  });

  it('у Пользователя без прав запрос отклоняется EntityNotFoundException и не раскрывает содержимое Задачи', async () => {
    await fc.assert(
      fc.asyncProperty(requesterRoleArb, taskShapeArb, async (role, shape) => {
        const store: Store = { users: new Map(), tasks: new Map() };

        // Запрашивающий — активный Пользователь без назначения на эту Задачу.
        store.users.set(REQUESTER_ID, {
          id: REQUESTER_ID,
          role,
          deletedAt: null,
        } as unknown as User);

        const secretTitle = shape.title;
        const secretDescription = shape.description;

        const task = {
          id: shape.id,
          title: secretTitle,
          description: secretDescription,
          status: shape.status,
          deadline: new Date('2099-01-01T00:00:00.000Z'),
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
          updatedAt: new Date('2020-01-01T00:00:00.000Z'),
          assignments: shape.assignments.map((a, idx) => ({
            id: `assignment-${idx}`,
            taskId: shape.id,
            userId: a.userId, // никогда не равен REQUESTER_ID
            kind: a.kind,
          })),
        } as unknown as TaskWithAssignments;
        store.tasks.set(shape.id, task);

        const service = buildService(store);

        // Запрос должен быть отклонён: содержимое не возвращается (Req 2.12).
        let caught: unknown;
        let resolved: TaskWithAssignments | undefined;
        try {
          resolved = await service.getVisibleTask(REQUESTER_ID, shape.id);
        } catch (err) {
          caught = err;
        }

        // Никакого содержимого Задачи не возвращено.
        expect(resolved).toBeUndefined();
        // Отказ — именно «не найдена/недоступна», не отличающий доступ от наличия.
        expect(caught).toBeInstanceOf(EntityNotFoundException);

        // Брошенная ошибка не несёт ни Названия, ни Описания, ни иных секретов.
        const footprint = errorFootprint(caught);
        expect(footprint).not.toContain(secretTitle);
        if (secretDescription !== null) {
          expect(footprint).not.toContain(secretDescription);
        }
        // На всякий случай: общий маркер секрета вообще не должен утечь.
        expect(footprint).not.toContain('§');
      }),
      { numRuns: 200 },
    );
  });
});
