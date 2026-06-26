import { AssignmentKind, Prisma, Role, Task, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { PaginationQueryDto } from '../common/dto';
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
 * Модульные тесты видимости Задач, доступа и правил назначения
 * {@link TasksService.listVisible}/{@link TasksService.getVisibleTask}/
 * {@link TasksService.assign} (Req 2.4–2.10, 2.12) с подменой репозиториев,
 * без обращения к реальной базе данных.
 */

const LIMITS = {
  taskTitleMaxLength: 200,
  taskDescriptionMaxLength: 5000,
  maxAssigneesPerTask: 100,
};

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

function makeTask(
  id: string,
  assignments: Array<{ userId: string; kind: AssignmentKind }>,
  status: TaskStatus = TaskStatus.IN_PROGRESS,
): TaskWithAssignments {
  return {
    id,
    title: `task-${id}`,
    description: null,
    deadline: new Date('2030-01-01T10:00:00Z'),
    status,
    adminReviewed: false,
    messageCount: 0,
    createdAt: new Date('2029-12-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2029-12-01T00:00:00Z'),
    assignments: assignments.map((a, i) => ({
      id: `${id}-a${i}`,
      taskId: id,
      userId: a.userId,
      kind: a.kind,
    })),
  } as unknown as TaskWithAssignments;
}

interface Fixture {
  users: Record<string, User>;
  tasks: Record<string, TaskWithAssignments>;
}

function buildService(fixture: Fixture) {
  const findActiveById = jest.fn(async (id: string) => fixture.users[id] ?? null);
  const findManyActiveByIds = jest.fn(async (ids: string[]) =>
    ids.map((id) => fixture.users[id]).filter((u): u is User => u !== undefined),
  );

  const findByIdWithAssignments = jest.fn(async (id: string) => fixture.tasks[id] ?? null);

  const list = jest.fn(async (pagination: PaginationQueryDto, where: Prisma.TaskWhereInput) => {
    const all = Object.values(fixture.tasks);
    const items = all.filter((t) => matchesWhere(t, where));
    return {
      items: items as unknown as Task[],
      meta: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: items.length,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
      },
    };
  });

  let replaced: { taskId: string; executorIds: string[]; managerIds: string[] } | undefined;
  const replaceAssignments = jest.fn(
    async (taskId: string, executorIds: string[], managerIds: string[]) => {
      replaced = { taskId, executorIds, managerIds };
      return makeTask(taskId, [
        ...executorIds.map((userId) => ({ userId, kind: AssignmentKind.EXECUTOR })),
        ...managerIds.map((userId) => ({ userId, kind: AssignmentKind.MANAGER })),
      ]);
    },
  );

  const taskRepository = {
    findByIdWithAssignments,
    list,
    replaceAssignments,
  } as unknown as TaskRepository;
  const userRepository = {
    findActiveById,
    findManyActiveByIds,
  } as unknown as UserRepository;
  const config = { limits: LIMITS } as unknown as AppConfigService;
  const enqueueTaskAssigned = jest.fn<Promise<void>, [unknown]>(async () => undefined);
  const enqueueTaskUnassigned = jest.fn<Promise<void>, [unknown]>(async () => undefined);

  const service = new TasksService(
    taskRepository,
    userRepository,
    config,
    {} as unknown as MessageRepository,
    { record: async () => undefined },
    {
      enqueueTaskUpdated: async () => undefined,
      enqueueTaskAssigned,
      enqueueTaskUnassigned,
    } as never,
  );
  return {
    service,
    list,
    replaceAssignments,
    enqueueTaskAssigned,
    enqueueTaskUnassigned,
    getReplaced: () => replaced,
  };
}

/** Минимальная интерпретация условия видимости из {@link buildVisibilityWhere}. */
function matchesWhere(task: TaskWithAssignments, where: Prisma.TaskWhereInput): boolean {
  if (Object.keys(where).length === 0) {
    return true; // администратор — все задачи
  }
  const some = (
    where.assignments as
      | { some?: { userId?: string; kind?: AssignmentKind | { in?: AssignmentKind[] } } }
      | undefined
  )?.some;
  if (some === undefined) {
    return true;
  }
  // Условие по виду назначения может быть как одиночным `kind`, так и формой
  // `kind: { in: [...] }` (Менеджер видит Задачи, где назначен Менеджером ИЛИ
  // Исполнителем, Req 2.7).
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

function pagination(): PaginationQueryDto {
  const q = new PaginationQueryDto();
  return q;
}

describe('TasksService.listVisible — видимость по роли и назначениям (Req 2.8–2.10)', () => {
  const fixture: Fixture = {
    users: {
      admin: makeUser('admin', Role.ADMIN),
      mgr: makeUser('mgr', Role.MANAGER),
      exe: makeUser('exe', Role.EXECUTOR),
    },
    tasks: {
      t1: makeTask('t1', [
        { userId: 'mgr', kind: AssignmentKind.MANAGER },
        { userId: 'exe', kind: AssignmentKind.EXECUTOR },
      ]),
      t2: makeTask('t2', [
        { userId: 'other-mgr', kind: AssignmentKind.MANAGER },
        { userId: 'other-exe', kind: AssignmentKind.EXECUTOR },
      ]),
      t3: makeTask('t3', [
        { userId: 'mgr', kind: AssignmentKind.MANAGER },
        { userId: 'other-exe', kind: AssignmentKind.EXECUTOR },
      ]),
      t4: makeTask(
        't4',
        [{ userId: 'mgr', kind: AssignmentKind.EXECUTOR }],
        TaskStatus.WAITING,
      ),
      t5: makeTask(
        't5',
        [
          { userId: 'other-mgr', kind: AssignmentKind.MANAGER },
          { userId: 'other-exe', kind: AssignmentKind.EXECUTOR },
        ],
        TaskStatus.WAITING,
      ),
      t6: makeTask('t6', [{ userId: 'exe', kind: AssignmentKind.MANAGER }]),
    },
  };

  it('Администратор видит все Задачи (Req 2.10)', async () => {
    const { service } = buildService(fixture);
    const page = await service.listVisible('admin', pagination());
    expect(page.items.map((t) => t.id).sort()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  });

  it('Менеджер видит Задачи, где он Менеджер или Исполнитель, независимо от WAITING', async () => {
    const { service } = buildService(fixture);
    const page = await service.listVisible('mgr', pagination());
    expect(page.items.map((t) => t.id).sort()).toEqual(['t1', 't3', 't4']);
  });

  it('Исполнитель видит Задачи, где он назначен в любом виде', async () => {
    const { service } = buildService(fixture);
    const page = await service.listVisible('exe', pagination());
    expect(page.items.map((t) => t.id).sort()).toEqual(['t1', 't6']);
  });

  it('отклоняет запрос для несуществующей/удалённой учётной записи', async () => {
    const { service } = buildService(fixture);
    await expect(service.listVisible('ghost', pagination())).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
  });
});

describe('TasksService.getVisibleTask — отказ без раскрытия содержимого (Req 2.12)', () => {
  const fixture: Fixture = {
    users: {
      admin: makeUser('admin', Role.ADMIN),
      mgr: makeUser('mgr', Role.MANAGER),
      exe: makeUser('exe', Role.EXECUTOR),
      stranger: makeUser('stranger', Role.MANAGER),
    },
    tasks: {
      t1: makeTask('t1', [
        { userId: 'mgr', kind: AssignmentKind.MANAGER },
        { userId: 'exe', kind: AssignmentKind.EXECUTOR },
      ]),
    },
  };

  it('возвращает Задачу её Менеджеру', async () => {
    const { service } = buildService(fixture);
    await expect(service.getVisibleTask('mgr', 't1')).resolves.toMatchObject({ id: 't1' });
  });

  it('возвращает Задачу её Исполнителю', async () => {
    const { service } = buildService(fixture);
    await expect(service.getVisibleTask('exe', 't1')).resolves.toMatchObject({ id: 't1' });
  });

  it('возвращает любую Задачу Администратору', async () => {
    const { service } = buildService(fixture);
    await expect(service.getVisibleTask('admin', 't1')).resolves.toMatchObject({ id: 't1' });
  });

  it('отказывает Пользователю без прав, не раскрывая содержимое (Req 2.12)', async () => {
    const { service } = buildService(fixture);
    await expect(service.getVisibleTask('stranger', 't1')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('отказывает одинаково для несуществующей Задачи (Req 2.12)', async () => {
    const { service } = buildService(fixture);
    await expect(service.getVisibleTask('mgr', 'missing')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});

describe('TasksService.assign — правила назначения (Req 2.4–2.7)', () => {
  function baseFixture(): Fixture {
    return {
      users: {
        admin: makeUser('admin', Role.ADMIN),
        mgrA: makeUser('mgrA', Role.MANAGER),
        mgrB: makeUser('mgrB', Role.MANAGER),
        exe1: makeUser('exe1', Role.EXECUTOR),
        exe2: makeUser('exe2', Role.EXECUTOR),
        stranger: makeUser('stranger', Role.MANAGER),
      },
      tasks: {
        t1: makeTask('t1', [
          { userId: 'mgrA', kind: AssignmentKind.MANAGER },
          { userId: 'exe1', kind: AssignmentKind.EXECUTOR },
        ]),
        // Задача, где mgrB назначен Исполнителем (Req 2.4).
        t2: makeTask('t2', [
          { userId: 'admin', kind: AssignmentKind.MANAGER },
          { userId: 'mgrB', kind: AssignmentKind.EXECUTOR },
        ]),
      },
    };
  }

  function dto(executorIds: string[], managerIds: string[]): AssignmentDto {
    return { executorIds, managerIds } as AssignmentDto;
  }

  it('Менеджер Задачи может изменить состав Исполнителей (Req 2.7)', async () => {
    const { service, getReplaced } = buildService(baseFixture());
    const task = await service.assign('mgrA', 't1', dto(['exe1', 'exe2'], ['mgrA']));
    expect(task.assignments.filter((a) => a.kind === AssignmentKind.EXECUTOR)).toHaveLength(2);
    expect(getReplaced()).toEqual({
      taskId: 't1',
      executorIds: ['exe1', 'exe2'],
      managerIds: ['mgrA'],
    });
  });

  it('ставит уведомления только для добавленных и удалённых участников', async () => {
    const { service, enqueueTaskAssigned, enqueueTaskUnassigned } = buildService(baseFixture());

    await service.assign('mgrA', 't1', dto(['exe1', 'exe2'], ['mgrB']));

    expect(enqueueTaskAssigned.mock.calls.map(([event]) => event)).toEqual([
      { taskId: 't1', userId: 'exe2', kind: AssignmentKind.EXECUTOR },
      { taskId: 't1', userId: 'mgrB', kind: AssignmentKind.MANAGER },
    ]);
    expect(enqueueTaskUnassigned.mock.calls.map(([event]) => event)).toEqual([
      { taskId: 't1', userId: 'mgrA' },
    ]);
  });

  it('Администратор может назначить Менеджера Исполнителем (Req 2.5)', async () => {
    const { service, getReplaced } = buildService(baseFixture());
    await service.assign('admin', 't1', dto(['exe1', 'mgrB'], ['mgrA']));
    expect(getReplaced()?.executorIds).toContain('mgrB');
  });

  it('Менеджер не может назначить Менеджера Исполнителем — состав не меняется (Req 2.6)', async () => {
    const { service, replaceAssignments } = buildService(baseFixture());
    await expect(
      service.assign('mgrA', 't1', dto(['exe1', 'mgrB'], ['mgrA'])),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(replaceAssignments).not.toHaveBeenCalled();
  });

  it('Менеджер, назначенный Исполнителем, не может редактировать Задачу (Req 2.4)', async () => {
    const { service, replaceAssignments } = buildService(baseFixture());
    await expect(service.assign('mgrB', 't2', dto(['exe1'], ['admin']))).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect(replaceAssignments).not.toHaveBeenCalled();
  });

  it('несколько Менеджеров получают равные права — любой может назначать (Req 2.7)', async () => {
    const fixture = baseFixture();
    const t1 = fixture.tasks.t1;
    if (t1 === undefined) {
      throw new Error('Фикстура t1 не задана.');
    }
    t1.assignments.push({
      id: 't1-extra',
      taskId: 't1',
      userId: 'mgrB',
      kind: AssignmentKind.MANAGER,
    } as TaskWithAssignments['assignments'][number]);
    const { service, getReplaced } = buildService(fixture);
    await service.assign('mgrB', 't1', dto(['exe1', 'exe2'], ['mgrA', 'mgrB']));
    expect(getReplaced()?.taskId).toBe('t1');
  });

  it('отказывает в доступе к чужой Задаче без раскрытия (Req 2.12)', async () => {
    const { service, replaceAssignments } = buildService(baseFixture());
    await expect(service.assign('stranger', 't1', dto(['exe1'], ['mgrA']))).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(replaceAssignments).not.toHaveBeenCalled();
  });

  it('отклоняет пустой список Исполнителей (Req 9.1)', async () => {
    const { service } = buildService(baseFixture());
    await expect(service.assign('mgrA', 't1', dto([], ['mgrA']))).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('отклоняет назначение несуществующего Исполнителя', async () => {
    const { service } = buildService(baseFixture());
    await expect(service.assign('mgrA', 't1', dto(['ghost'], ['mgrA']))).rejects.toBeInstanceOf(
      ValidationException,
    );
  });
});
