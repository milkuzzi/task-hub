import { AssignmentKind, Prisma, Role, Task, TaskStatus, User } from '@prisma/client';
import { AccessDeniedException, ValidationException } from '../common/errors';
import { PaginationQueryDto, PAGINATION } from '../common/dto';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { CreateTaskDto } from './dto';
import { TasksService } from './tasks.service';

/**
 * Модульные тесты {@link TasksService.create} (Req 9.1–9.6) с подменой
 * репозиториев и конфигурации, без обращения к реальной базе данных.
 *
 * Проверяется валидация параметров (Req 9.1–9.3), начальный статус «В работе»
 * (Req 9.4) и создание ровно одного связанного Чата (Req 9.5) единым вложенным
 * запросом.
 */

const LIMITS = {
  taskTitleMaxLength: 200,
  taskDescriptionMaxLength: 5000,
  maxAssigneesPerTask: 100,
};

function makeActor(partial: Partial<User> & { id: string; role: Role }): User {
  return {
    email: `${partial.id}@example.com`,
    displayName: partial.id,
    isActive: true,
    deletedAt: null,
    lockedUntil: null,
    failedLoginCount: 0,
    ...partial,
  } as unknown as User;
}

function validDto(overrides: Partial<CreateTaskDto> = {}): CreateTaskDto {
  return {
    title: 'Подготовить отчёт',
    description: 'Описание задачи',
    deadline: new Date('2030-01-01T10:00:00Z'),
    executorIds: ['executor-1'],
    managerIds: ['manager-1'],
    ...overrides,
  } as CreateTaskDto;
}

function buildService(overrides: { actors?: Record<string, User> } = {}) {
  const actors = overrides.actors ?? { manager: makeActor({ id: 'manager', role: Role.MANAGER }) };

  const findActiveById = jest.fn(async (id: string) => actors[id] ?? null);
  const findManyActiveByIds = jest.fn(async (ids: string[]) =>
    ids.map((id) => actors[id] ?? inferActiveUser(id)).filter((u): u is User => u !== null),
  );

  let createInput: Prisma.TaskCreateInput | undefined;
  const storedTasks: TaskWithAssignments[] = [];
  const create = jest.fn(async (data: Prisma.TaskCreateInput) => {
    createInput = data;
    const task = {
      id: 'task-1',
      title: data.title,
      description: (data.description as string | null) ?? null,
      deadline: data.deadline as Date,
      status: (data.status as TaskStatus) ?? TaskStatus.IN_PROGRESS,
      adminReviewed: false,
      messageCount: 0,
      createdAt: new Date('2029-12-01T00:00:00Z'),
      doneAt: null,
      updatedAt: new Date('2029-12-01T00:00:00Z'),
    } as unknown as Task;
    const assignmentInput = data.assignments as
      | {
          create?: Array<{
            kind: AssignmentKind;
            user: { connect: { id: string } };
          }>;
        }
      | undefined;
    storedTasks.push({
      ...task,
      assignments: (assignmentInput?.create ?? []).map((assignment, index) => ({
        id: `a${index}`,
        taskId: 'task-1',
        userId: assignment.user.connect.id,
        kind: assignment.kind,
      })),
    } as unknown as TaskWithAssignments);
    return task;
  });

  const list = jest.fn(async (pagination: PaginationQueryDto, where: Prisma.TaskWhereInput) => {
    const matched = storedTasks.filter((task) => matchesTaskWhere(task, where));
    return {
      items: matched.slice(pagination.skip, pagination.skip + pagination.take) as unknown as Task[],
      meta: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: matched.length,
        totalPages: Math.max(1, Math.ceil(matched.length / pagination.pageSize)),
        hasNext: pagination.skip + pagination.take < matched.length,
        hasPrevious: pagination.page > PAGINATION.minPage,
      },
    };
  });

  const taskRepository = { create, list } as unknown as TaskRepository;
  const userRepository = { findActiveById, findManyActiveByIds } as unknown as UserRepository;
  const config = { limits: LIMITS } as unknown as AppConfigService;
  const enqueueTaskAssigned = jest.fn<Promise<void>, [unknown]>(async () => undefined);

  const service = new TasksService(
    taskRepository,
    userRepository,
    config,
    {} as unknown as MessageRepository,
    { record: async () => undefined },
    { enqueueTaskUpdated: async () => undefined, enqueueTaskAssigned } as never,
  );
  return {
    service,
    create,
    findActiveById,
    findManyActiveByIds,
    list,
    enqueueTaskAssigned,
    getCreateInput: () => createInput,
  };
}

function inferActiveUser(id: string): User | null {
  if (id === 'ghost' || id.startsWith('missing')) {
    return null;
  }
  const role =
    id === 'admin' || id.startsWith('admin-')
      ? Role.ADMIN
      : id.startsWith('m') || id.includes('manager')
        ? Role.MANAGER
        : Role.EXECUTOR;
  return makeActor({ id, role });
}

function matchesTaskWhere(task: TaskWithAssignments, where: Prisma.TaskWhereInput): boolean {
  if (Object.keys(where).length === 0) {
    return true;
  }
  const some = (
    where.assignments as
      { some?: { userId?: string; kind?: AssignmentKind | { in?: AssignmentKind[] } } } | undefined
  )?.some;
  if (some === undefined) {
    return true;
  }
  return task.assignments.some((assignment) => {
    if (assignment.userId !== some.userId) {
      return false;
    }
    const kind = some.kind;
    if (kind === undefined) {
      return true;
    }
    if (typeof kind === 'object' && kind !== null && 'in' in kind) {
      return (kind.in ?? []).includes(assignment.kind);
    }
    return assignment.kind === kind;
  });
}

function createdAssignments(input: Prisma.TaskCreateInput | undefined): Array<{
  kind: AssignmentKind;
  userId: string;
}> {
  const assignmentInput = input?.assignments as
    | {
        create?: Array<{
          kind: AssignmentKind;
          user: { connect: { id: string } };
        }>;
      }
    | undefined;
  return (assignmentInput?.create ?? []).map((assignment) => ({
    kind: assignment.kind,
    userId: assignment.user.connect.id,
  }));
}

describe('TasksService.create — успешное создание (Req 9.2, 9.4, 9.5)', () => {
  it('создаёт задачу со статусом «В работе» и связанным чатом (Req 9.4, 9.5)', async () => {
    const { service, getCreateInput } = buildService();

    const task = await service.create('manager', validDto());

    expect(task.status).toBe(TaskStatus.IN_PROGRESS);

    const input = getCreateInput();
    expect(input?.status).toBe(TaskStatus.IN_PROGRESS);
    // Ровно один связанный чат (Req 9.5).
    expect(input?.chat).toEqual({ create: {} });
  });

  it('создаёт назначения исполнителей и менеджеров нужного вида (Req 9.1)', async () => {
    const { service, getCreateInput } = buildService();

    await service.create('manager', validDto({ executorIds: ['e1', 'e2'], managerIds: ['m1'] }));

    const assignments = createdAssignments(getCreateInput());
    const executors = assignments.filter((a) => a.kind === AssignmentKind.EXECUTOR);
    const managers = assignments.filter((a) => a.kind === AssignmentKind.MANAGER);
    expect(executors).toHaveLength(2);
    expect(managers).toHaveLength(2);
    expect(managers.map((a) => a.userId).sort()).toEqual(['m1', 'manager']);
  });

  it('добавляет создающего Менеджера в менеджеры задачи, если он не выбран явно', async () => {
    const { service, getCreateInput } = buildService();

    await service.create('manager', validDto({ managerIds: ['other-manager'] }));

    const managers = createdAssignments(getCreateInput())
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);
    expect(managers).toEqual(['other-manager', 'manager']);
  });

  it('не добавляет создающего Администратора в менеджеры задачи', async () => {
    const { service, getCreateInput } = buildService({
      actors: { admin: makeActor({ id: 'admin', role: Role.ADMIN }) },
    });

    await service.create('admin', validDto({ managerIds: ['manager-1'] }));

    const managers = createdAssignments(getCreateInput())
      .filter((a) => a.kind === AssignmentKind.MANAGER)
      .map((a) => a.userId);
    expect(managers).toEqual(['manager-1']);
  });

  it('отклоняет Администратора в списке менеджеров при создании задачи', async () => {
    const { service, create } = buildService({
      actors: { admin: makeActor({ id: 'admin', role: Role.ADMIN }) },
    });

    await expect(
      service.create('admin', validDto({ managerIds: ['admin'] })),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет Администратора в списке исполнителей при создании задачи', async () => {
    const { service, create } = buildService();

    await expect(
      service.create('manager', validDto({ executorIds: ['admin'] })),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('возвращает созданную задачу в списке создающего Менеджера', async () => {
    const { service } = buildService();

    await service.create('manager', validDto({ managerIds: ['other-manager'] }));

    const query = new PaginationQueryDto();
    query.page = 1;
    query.pageSize = 10;
    const page = await service.listVisible('manager', query);

    expect(page.items.map((task) => task.id)).toEqual(['task-1']);
  });

  it('ставит уведомления о назначении всем начальным участникам задачи', async () => {
    const { service, enqueueTaskAssigned } = buildService();

    await service.create('manager', validDto({ executorIds: ['e1', 'e2'], managerIds: ['m1'] }));

    expect(enqueueTaskAssigned).toHaveBeenCalledTimes(4);
    expect(enqueueTaskAssigned.mock.calls.map(([event]) => event)).toEqual([
      {
        taskId: 'task-1',
        userId: 'e1',
        kind: AssignmentKind.EXECUTOR,
        taskTitle: 'Подготовить отчёт',
      },
      {
        taskId: 'task-1',
        userId: 'e2',
        kind: AssignmentKind.EXECUTOR,
        taskTitle: 'Подготовить отчёт',
      },
      {
        taskId: 'task-1',
        userId: 'm1',
        kind: AssignmentKind.MANAGER,
        taskTitle: 'Подготовить отчёт',
      },
      {
        taskId: 'task-1',
        userId: 'manager',
        kind: AssignmentKind.MANAGER,
        taskTitle: 'Подготовить отчёт',
      },
    ]);
  });

  it('дедуплицирует повторяющиеся идентификаторы исполнителей/менеджеров', async () => {
    const { service, getCreateInput } = buildService();

    await service.create(
      'manager',
      validDto({ executorIds: ['e1', 'e1', 'e2'], managerIds: ['m1', 'm1'] }),
    );

    const assignments = createdAssignments(getCreateInput());
    expect(assignments.filter((a) => a.kind === AssignmentKind.EXECUTOR)).toHaveLength(2);
    expect(assignments.filter((a) => a.kind === AssignmentKind.MANAGER)).toHaveLength(2);
  });

  it('допускает пустое (отсутствующее) описание — 0 символов (Req 9.1)', async () => {
    const { service, getCreateInput } = buildService();
    const dto = {
      title: 'Без описания',
      deadline: new Date('2030-01-01T10:00:00Z'),
      executorIds: ['executor-1'],
      managerIds: ['manager-1'],
    } as CreateTaskDto;

    await service.create('manager', dto);

    expect(getCreateInput()?.description).toBeNull();
  });

  it('разрешает Администратору создавать задачи (Req 2.3, 9.2)', async () => {
    const { service } = buildService({
      actors: { admin: makeActor({ id: 'admin', role: Role.ADMIN }) },
    });

    const task = await service.create('admin', validDto());

    expect(task.status).toBe(TaskStatus.IN_PROGRESS);
  });

  it('принимает Название длиной ровно 200 символов (граница, Req 9.1)', async () => {
    const { service } = buildService();

    const task = await service.create('manager', validDto({ title: 'A'.repeat(200) }));

    expect(task.title).toHaveLength(200);
  });

  it('принимает 100 исполнителей и 100 менеджеров (граница, Req 9.1)', async () => {
    const { service, getCreateInput } = buildService();
    const executorIds = Array.from({ length: 100 }, (_, i) => `e${i}`);
    const managerIds = ['manager', ...Array.from({ length: 99 }, (_, i) => `m${i}`)];

    await service.create('manager', validDto({ executorIds, managerIds }));

    const assignments = (getCreateInput()?.assignments as { create: unknown[] }).create;
    expect(assignments).toHaveLength(200);
  });
});

describe('TasksService.create — валидация параметров (Req 9.1, 9.3)', () => {
  it('отклоняет пустое Название и не создаёт задачу (Req 9.3)', async () => {
    const { service, create } = buildService();

    await expect(service.create('manager', validDto({ title: '   ' }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет Название длиннее 200 символов (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();

    await expect(
      service.create('manager', validDto({ title: 'A'.repeat(201) })),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет Описание длиннее 5000 символов (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();

    await expect(
      service.create('manager', validDto({ description: 'A'.repeat(5001) })),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет некорректный Дедлайн (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();

    await expect(
      service.create('manager', validDto({ deadline: new Date('invalid') })),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет пустой список Исполнителей (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();

    await expect(service.create('manager', validDto({ executorIds: [] }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет пустой список Менеджеров (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();

    await expect(service.create('manager', validDto({ managerIds: [] }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет более 100 уникальных Исполнителей (Req 9.1, 9.3)', async () => {
    const { service, create } = buildService();
    const executorIds = Array.from({ length: 101 }, (_, i) => `e${i}`);

    await expect(service.create('manager', validDto({ executorIds }))).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('сообщение об ошибке указывает на конкретный некорректный параметр (Req 9.3)', async () => {
    const { service } = buildService();

    await expect(service.create('manager', validDto({ title: '' }))).rejects.toThrow(/Название/);
    await expect(service.create('manager', validDto({ executorIds: [] }))).rejects.toThrow(
      /Исполнители/,
    );
    await expect(service.create('manager', validDto({ managerIds: [] }))).rejects.toThrow(
      /Менеджеры/,
    );
  });
});

describe('TasksService.create — права инициатора (Req 9.2)', () => {
  it('запрещает создание Исполнителю (Req 9.2)', async () => {
    const { service, create } = buildService({
      actors: { e1: makeActor({ id: 'e1', role: Role.EXECUTOR }) },
    });

    await expect(service.create('e1', validDto())).rejects.toBeInstanceOf(AccessDeniedException);
    expect(create).not.toHaveBeenCalled();
  });

  it('отклоняет создание для несуществующего/удалённого инициатора', async () => {
    const { service, create } = buildService();

    await expect(service.create('ghost', validDto())).rejects.toBeInstanceOf(AccessDeniedException);
    expect(create).not.toHaveBeenCalled();
  });
});
