import fc from 'fast-check';
import { Role, Task, User } from '@prisma/client';
import { ValidationException } from '../common/errors';
import { AppConfigService } from '../config';
import { MessageRepository, TaskRepository, UserRepository } from '../repositories';
import { TasksService } from './tasks.service';
import { CreateTaskDto, TASK_PARAM_BOUNDS } from './dto';

/**
 * **Feature: task-assignment-system, Property 22: Валидация параметров задачи при создании**
 *
 * Property 22 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 9.1, 9.2, 9.3**:
 *
 * Для любого набора параметров Задача создаётся тогда и только тогда, когда все
 * обязательные параметры присутствуют и в границах (Название 1–200, Описание
 * 0–5000, Дедлайн задан, Исполнители 1–100, Менеджеры 1–100); при нарушении
 * границ создание отклоняется, возвращается ошибка с указанием параметра, а
 * ранее введённые значения сохраняются (Задача не создаётся).
 *
 * Тест реализует ровно ЭТО ОДНО свойство. Все внешние границы
 * ({@link TaskRepository}, {@link UserRepository}, {@link AppConfigService})
 * подменяются мок-объектами — обращений к реальной БД/Redis/конфигурации нет.
 * Инициатор всегда имеет привилегии Менеджера, поэтому единственным фактором
 * исхода остаётся валидация параметров (Req 9.1–9.3).
 *
 * Эталонная модель повторяет порядок проверок {@link TasksService.create}:
 * параметры проверяются в порядке Название → Описание → Дедлайн → Исполнители →
 * Менеджеры; границы списков считаются по числу УНИКАЛЬНЫХ идентификаторов.
 */
describe('Property 22: Валидация параметров задачи при создании (Req 9.1, 9.2, 9.3)', () => {
  const MANAGER_ID = 'manager-1';

  /** Какой параметр (по порядку проверки сервиса) первым нарушает границы. */
  type InvalidParam = 'title' | 'description' | 'deadline' | 'executors' | 'managers' | null;

  /** Русское ключевое слово в сообщении об ошибке для каждого параметра. */
  const PARAM_KEYWORD: Record<Exclude<InvalidParam, null>, string> = {
    title: 'Название',
    description: 'Описание',
    deadline: 'Дедлайн',
    executors: 'Исполнители',
    managers: 'Менеджеры',
  };

  /**
   * Проверяет список назначений так же, как {@link TasksService}: все элементы
   * должны быть непустыми строками, а число уникальных значений — в границах
   * 1..100. Возвращает `true`, если список НЕдопустим.
   */
  function assigneesInvalid(ids: string[]): boolean {
    if (ids.some((id) => id.length === 0)) {
      return true;
    }
    const unique = new Set(ids).size;
    return unique < TASK_PARAM_BOUNDS.assigneesMin || unique > TASK_PARAM_BOUNDS.assigneesMax;
  }

  /**
   * Эталон: возвращает первый нарушающий границы параметр в порядке проверки
   * сервиса, либо `null`, если все параметры корректны (Задача должна быть
   * создана).
   */
  function firstInvalidParam(dto: CreateTaskDto): InvalidParam {
    if (dto.title.trim().length === 0 || dto.title.length > TASK_PARAM_BOUNDS.titleMaxLength) {
      return 'title';
    }
    if (
      dto.description !== undefined &&
      dto.description !== null &&
      dto.description.length > TASK_PARAM_BOUNDS.descriptionMaxLength
    ) {
      return 'description';
    }
    if (!(dto.deadline instanceof Date) || Number.isNaN(dto.deadline.getTime())) {
      return 'deadline';
    }
    if (assigneesInvalid(dto.executorIds)) {
      return 'executors';
    }
    if (assigneesInvalid(dto.managerIds)) {
      return 'managers';
    }
    return null;
  }

  /**
   * Строит сервис с мок-границами. Инициатор — активный Администратор (обладает
   * привилегиями Менеджера, Req 9.2). `taskRepository.create` фиксирует вызовы и
   * возвращает синтетическую Задачу.
   */
  function buildService() {
    const createCalls: unknown[] = [];

    const userRepository = {
      findActiveById: jest.fn(async (id: string) =>
        id === MANAGER_ID
          ? ({ id, role: Role.ADMIN, deletedAt: null, isActive: true } as unknown as User)
          : null,
      ),
    } as unknown as UserRepository;

    const taskRepository = {
      create: jest.fn(async (data: unknown) => {
        createCalls.push(data);
        return { id: 'task-1', status: 'IN_PROGRESS' } as unknown as Task;
      }),
    } as unknown as TaskRepository;

    const config = {
      limits: {
        taskTitleMaxLength: TASK_PARAM_BOUNDS.titleMaxLength,
        taskDescriptionMaxLength: TASK_PARAM_BOUNDS.descriptionMaxLength,
        maxAssigneesPerTask: TASK_PARAM_BOUNDS.assigneesMax,
      },
    } as unknown as AppConfigService;

    const service = new TasksService(
      taskRepository,
      userRepository,
      config,
      {} as unknown as MessageRepository,
      { record: async () => undefined },
      { enqueueTaskUpdated: async () => undefined },
    );
    return { service, taskRepository, createCalls };
  }

  // --- Арбитрари, покрывающие как допустимые, так и недопустимые значения ---

  /** Идентификатор: непустая строка либо (редко) пустая — недопустимый элемент. */
  const idArb = fc.oneof(
    { weight: 9, arbitrary: fc.string({ minLength: 1, maxLength: 6 }) },
    { weight: 1, arbitrary: fc.constant('') },
  );

  /** Список назначений: длина 0..105 — покрывает границы 1 и 100. */
  const assigneesArb = fc.array(idArb, { minLength: 0, maxLength: 105 });

  /** Название: пустые/пробельные/нормальные/превышающие 200 символов. */
  const titleArb = fc.oneof(
    fc.string({ maxLength: 220 }),
    fc.string({ minLength: 201, maxLength: 240 }),
    fc.constant(''),
    fc.constant('   '),
  );

  /** Описание: отсутствует, нормальное или превышающее 5000 символов. */
  const descriptionArb = fc.oneof(fc.constant(undefined), fc.string({ maxLength: 5200 }));

  /** Дедлайн: корректная дата либо некорректная (NaN). */
  const deadlineArb = fc.oneof(
    fc
      .date({
        min: new Date('2000-01-01T00:00:00.000Z'),
        max: new Date('2100-01-01T00:00:00.000Z'),
      })
      .filter((d) => !Number.isNaN(d.getTime())),
    fc.constant(new Date(Number.NaN)),
  );

  const dtoArb: fc.Arbitrary<CreateTaskDto> = fc.record({
    title: titleArb,
    description: descriptionArb,
    deadline: deadlineArb,
    executorIds: assigneesArb,
    managerIds: assigneesArb,
  }) as unknown as fc.Arbitrary<CreateTaskDto>;

  it('создаётся ⇔ все параметры присутствуют и в границах; иначе отказ с указанием параметра и без создания', async () => {
    await fc.assert(
      fc.asyncProperty(dtoArb, async (dto) => {
        const { service, taskRepository, createCalls } = buildService();

        // Снимок введённых значений: при отказе они должны сохраниться (Req 9.3).
        const snapshot = {
          title: dto.title,
          description: dto.description,
          deadline: dto.deadline,
          executorIds: [...dto.executorIds],
          managerIds: [...dto.managerIds],
        };

        const invalid = firstInvalidParam(dto);

        if (invalid === null) {
          // Все параметры в границах ⇒ Задача создаётся (Req 9.1, 9.4).
          await expect(service.create(MANAGER_ID, dto)).resolves.toBeDefined();
          expect(taskRepository.create).toHaveBeenCalledTimes(1);
        } else {
          // Нарушение границ ⇒ отказ с указанием параметра (Req 9.1, 9.3).
          let caught: unknown;
          try {
            await service.create(MANAGER_ID, dto);
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(ValidationException);
          expect((caught as ValidationException).message).toContain(PARAM_KEYWORD[invalid]);
          // Задача не создаётся: репозиторий не вызывается (Req 9.3).
          expect(taskRepository.create).not.toHaveBeenCalled();
          expect(createCalls).toHaveLength(0);
        }

        // Введённые значения не мутируются сервисом (сохраняются, Req 9.3).
        expect(dto.title).toBe(snapshot.title);
        expect(dto.description).toBe(snapshot.description);
        expect(dto.deadline).toBe(snapshot.deadline);
        expect(dto.executorIds).toEqual(snapshot.executorIds);
        expect(dto.managerIds).toEqual(snapshot.managerIds);
      }),
      { numRuns: 300 },
    );
  });
});
