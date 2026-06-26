import fc from 'fast-check';
import { AssignmentKind, Prisma, Role, Task, TaskStatus, User } from '@prisma/client';
import { AppConfigService } from '../config';
import { MessageRepository, TaskRepository, UserRepository } from '../repositories';
import { CreateTaskDto } from './dto';
import { TasksService } from './tasks.service';

/**
 * **Feature: task-assignment-system, Property 23: Начальное состояние созданной задачи**
 *
 * Property 23 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 9.4, 9.5**:
 *
 * Для любой успешно созданной задачи её статус равен «В работе»
 * (`TaskStatus.IN_PROGRESS`, Req 9.4), и с ней связан ровно один чат (Req 9.5).
 *
 * Для любого валидного набора входных параметров (Название 1–200, Описание
 * 0–5000 либо отсутствует, корректный Дедлайн, 1–100 Исполнителей, 1–100
 * Менеджеров) и любого инициатора с привилегиями Менеджера (Менеджер либо
 * Администратор) вызов {@link TasksService.create} завершается успешно, а
 * возвращённая задача имеет статус «В работе» и порождает запрос создания ровно
 * одного связанного Чата.
 *
 * Границы БД ({@link TaskRepository}, {@link UserRepository}) и конфигурация
 * ({@link AppConfigService}) подменяются детерминированными моками с тем же
 * контрактом: `findActiveById` возвращает инициатора с заданной ролью, `create`
 * фиксирует переданный {@link Prisma.TaskCreateInput} и отражает статус во
 * возвращаемой задаче. Обращений к реальной базе нет.
 *
 * Тест реализует ровно ОДНО свойство. Минимум 100 итераций fast-check (здесь — 200).
 */
describe('Property 23: Начальное состояние созданной задачи (Req 9.4, 9.5)', () => {
  const LIMITS = {
    taskTitleMaxLength: 200,
    taskDescriptionMaxLength: 5000,
    maxAssigneesPerTask: 100,
  };

  /**
   * Подменный {@link TasksService} с моками репозиториев и конфигурации.
   * Возвращает сервис, мок `create` и геттер захваченного входа создания.
   */
  function buildService(actorRole: Role) {
    const actorId = 'initiator';
    const actor = {
      id: actorId,
      email: 'initiator@example.com',
      displayName: 'Инициатор',
      role: actorRole,
      isActive: true,
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
    } as unknown as User;

    const findActiveById = jest.fn(async (id: string) => (id === actorId ? actor : null));

    let createInput: Prisma.TaskCreateInput | undefined;
    const create = jest.fn(async (data: Prisma.TaskCreateInput) => {
      createInput = data;
      // Возвращаемая задача отражает явно переданный статус (Req 9.4).
      return {
        id: 'task-1',
        title: data.title,
        description: (data.description as string | null) ?? null,
        deadline: data.deadline as Date,
        status: data.status as TaskStatus,
        adminReviewed: false,
        messageCount: 0,
        createdAt: new Date('2030-01-01T00:00:00Z'),
        doneAt: null,
        updatedAt: new Date('2030-01-01T00:00:00Z'),
      } as unknown as Task;
    });

    const taskRepository = { create } as unknown as TaskRepository;
    const userRepository = { findActiveById } as unknown as UserRepository;
    const config = { limits: LIMITS } as unknown as AppConfigService;

    const service = new TasksService(
      taskRepository,
      userRepository,
      config,
      {} as unknown as MessageRepository,
      { record: async () => undefined },
      { enqueueTaskUpdated: async () => undefined },
    );
    return { service, actorId, getCreateInput: () => createInput };
  }

  /** Идентификаторы назначений — непустые строки, без повтора пустых значений. */
  const idArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.length > 0);

  /** Генератор валидного набора параметров создания Задачи (границы Req 9.1). */
  const validDtoArb: fc.Arbitrary<CreateTaskDto> = fc.record({
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((t) => t.trim().length > 0),
    description: fc.option(fc.string({ minLength: 0, maxLength: 5000 }), { nil: undefined }),
    deadline: fc
      .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') })
      .filter((d) => !Number.isNaN(d.getTime())),
    executorIds: fc.array(idArb, { minLength: 1, maxLength: 100 }),
    managerIds: fc.array(idArb, { minLength: 1, maxLength: 100 }),
  }) as unknown as fc.Arbitrary<CreateTaskDto>;

  it('успешно созданная задача имеет статус «В работе» и ровно один связанный чат', async () => {
    await fc.assert(
      fc.asyncProperty(
        validDtoArb,
        fc.constantFrom(Role.MANAGER, Role.ADMIN),
        async (dto, role) => {
          const { service, actorId, getCreateInput } = buildService(role);

          const task = await service.create(actorId, dto);

          // Req 9.4: статус созданной задачи — «В работе».
          expect(task.status).toBe(TaskStatus.IN_PROGRESS);

          const input = getCreateInput();
          expect(input).toBeDefined();
          expect(input?.status).toBe(TaskStatus.IN_PROGRESS);

          // Req 9.5: с задачей связан ровно один чат — единственный вложенный
          // запрос создания Чата.
          expect(input?.chat).toEqual({ create: {} });

          // Назначения сформированы из входа (целостность создания).
          const assignments = (input?.assignments as { create: Array<{ kind: AssignmentKind }> })
            .create;
          expect(assignments.length).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 200 },
    );
  });
});
