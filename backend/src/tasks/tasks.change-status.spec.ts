import { AssignmentKind, Role, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  StateConflictException,
} from '../common/errors';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { StatusMachine, StatusAction } from '../status';
import { AuditFieldChange } from './ports';
import { TasksService } from './tasks.service';

/**
 * Модульные тесты {@link TasksService.changeStatus} (Req 10.4–10.10, 10.14,
 * 10.15, 20.1) с подменой репозиториев — без обращения к реальной базе данных.
 *
 * Проверяются: успешный переход (сохранение + запись в Журнал), отказ при
 * отсутствии прав (`NO_PERMISSION` → AccessDenied), отказ при недопустимом
 * переходе (`INVALID_TRANSITION` → StateConflict) и нераскрытие чужой Задачи
 * (доступ NONE → EntityNotFound).
 */

interface Assignment {
  userId: string;
  kind: AssignmentKind;
}

function makeActor(id: string, role: Role): User {
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
  status: TaskStatus,
  assignments: Assignment[],
  adminReviewed = false,
): TaskWithAssignments {
  return {
    id: 'task-1',
    title: 'Задача',
    description: null,
    deadline: new Date('2030-01-01T10:00:00Z'),
    status,
    adminReviewed,
    messageCount: 0,
    createdAt: new Date('2029-12-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2029-12-01T00:00:00Z'),
    assignments: assignments.map((a, i) => ({
      id: `a${i}`,
      taskId: 'task-1',
      userId: a.userId,
      kind: a.kind,
    })),
  } as unknown as TaskWithAssignments;
}

function buildService(options: { actor: User | null; task: TaskWithAssignments | null }) {
  const findActiveById = jest.fn(async (id: string) =>
    options.actor !== null && options.actor.id === id ? options.actor : null,
  );

  let currentStatus = options.task?.status ?? TaskStatus.IN_PROGRESS;
  const findByIdWithAssignments = jest.fn(async () => {
    if (options.task === null) {
      return null;
    }
    return { ...options.task, status: currentStatus } as TaskWithAssignments;
  });

  const setStatus = jest.fn(async (_id: string, status: TaskStatus) => {
    currentStatus = status;
    return { id: 'task-1', status } as unknown as never;
  });

  const record = jest.fn<Promise<void>, [AuditFieldChange]>(async () => undefined);
  const enqueueStatusChanged = jest.fn(async () => undefined);

  const taskRepository = {
    findByIdWithAssignments,
    setStatus,
  } as unknown as TaskRepository;
  const userRepository = { findActiveById } as unknown as UserRepository;
  const config = { limits: { messageCounterCap: 9999 } } as unknown as AppConfigService;

  const service = new TasksService(
    taskRepository,
    userRepository,
    config,
    {} as unknown as MessageRepository,
    { record },
    { enqueueTaskUpdated: async () => undefined, enqueueStatusChanged },
    new StatusMachine(),
  );

  return { service, setStatus, record, enqueueStatusChanged, findByIdWithAssignments };
}

const COMPLETE: StatusAction = { type: 'COMPLETE' };
const START_WORK: StatusAction = { type: 'START_WORK' };
const REOPEN: StatusAction = { type: 'REOPEN' };

describe('TasksService.changeStatus — успешный переход (Req 10.4, 20.1)', () => {
  it('сохраняет новый Статус и записывает смену в Журнал', async () => {
    const task = makeTask(TaskStatus.IN_PROGRESS, [
      { userId: 'mgr', kind: AssignmentKind.MANAGER },
    ]);
    const { service, setStatus, record, enqueueStatusChanged } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    const result = await service.changeStatus('mgr', 'task-1', COMPLETE);

    expect(setStatus).toHaveBeenCalledWith('task-1', TaskStatus.DONE);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      taskId: 'task-1',
      authorId: 'mgr',
      field: 'status',
      oldValue: TaskStatus.IN_PROGRESS,
      newValue: TaskStatus.DONE,
    });
    expect(enqueueStatusChanged).toHaveBeenCalledWith({
      taskId: 'task-1',
      actorId: 'mgr',
      newStatus: TaskStatus.DONE,
      taskTitle: 'Задача',
      executorIds: [],
      managerIds: ['mgr'],
    });
    expect(result.status).toBe(TaskStatus.DONE);
  });

  it('разрешает Администратору выбрать целевой Статус из «Требует администратора» (Req 10.9)', async () => {
    const task = makeTask(TaskStatus.NEEDS_ADMIN, [
      { userId: 'e1', kind: AssignmentKind.EXECUTOR },
    ]);
    const { service, setStatus } = buildService({
      actor: makeActor('admin', Role.ADMIN),
      task,
    });

    const result = await service.changeStatus('admin', 'task-1', {
      type: 'ADMIN_SET',
      target: 'WAITING',
    });

    expect(setStatus).toHaveBeenCalledWith('task-1', TaskStatus.WAITING);
    expect(result.status).toBe(TaskStatus.WAITING);
  });

  it('разрешает Менеджеру перевести Задачу из «Ожидает» в «В работе»', async () => {
    const task = makeTask(TaskStatus.WAITING, [
      { userId: 'mgr', kind: AssignmentKind.MANAGER },
      { userId: 'e1', kind: AssignmentKind.EXECUTOR },
    ]);
    const { service, setStatus, record, enqueueStatusChanged } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    const result = await service.changeStatus('mgr', 'task-1', START_WORK);

    expect(setStatus).toHaveBeenCalledWith('task-1', TaskStatus.IN_PROGRESS);
    expect(record.mock.calls[0]![0]).toMatchObject({
      taskId: 'task-1',
      authorId: 'mgr',
      field: 'status',
      oldValue: TaskStatus.WAITING,
      newValue: TaskStatus.IN_PROGRESS,
    });
    expect(enqueueStatusChanged).toHaveBeenCalledWith({
      taskId: 'task-1',
      actorId: 'mgr',
      newStatus: TaskStatus.IN_PROGRESS,
      taskTitle: 'Задача',
      executorIds: ['e1'],
      managerIds: ['mgr'],
    });
    expect(result.status).toBe(TaskStatus.IN_PROGRESS);
  });
});

describe('TasksService.changeStatus — отказы (Req 10.14, 10.15, 2.12)', () => {
  it('отклоняет действие Исполнителя как отсутствие прав и не меняет состояние (Req 10.14)', async () => {
    const task = makeTask(TaskStatus.IN_PROGRESS, [
      { userId: 'e1', kind: AssignmentKind.EXECUTOR },
    ]);
    const { service, setStatus, record, enqueueStatusChanged } = buildService({
      actor: makeActor('e1', Role.EXECUTOR),
      task,
    });

    await expect(service.changeStatus('e1', 'task-1', COMPLETE)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(enqueueStatusChanged).not.toHaveBeenCalled();
  });

  it('отклоняет недопустимый переход конфликтом состояния и не меняет состояние (Req 10.15)', async () => {
    // REOPEN допустим только из «Выполнено»; из «В работе» — недопустим.
    const task = makeTask(TaskStatus.IN_PROGRESS, [
      { userId: 'mgr', kind: AssignmentKind.MANAGER },
    ]);
    const { service, setStatus, record, enqueueStatusChanged } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    await expect(service.changeStatus('mgr', 'task-1', REOPEN)).rejects.toBeInstanceOf(
      StateConflictException,
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(enqueueStatusChanged).not.toHaveBeenCalled();
  });

  it('не раскрывает чужую Задачу (доступ NONE → не найдена, Req 2.12)', async () => {
    const task = makeTask(TaskStatus.IN_PROGRESS, [
      { userId: 'other', kind: AssignmentKind.MANAGER },
    ]);
    const { service, setStatus } = buildService({
      actor: makeActor('stranger', Role.MANAGER),
      task,
    });

    await expect(service.changeStatus('stranger', 'task-1', COMPLETE)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('отклоняет неактивного инициатора отказом в доступе', async () => {
    const task = makeTask(TaskStatus.IN_PROGRESS, [
      { userId: 'mgr', kind: AssignmentKind.MANAGER },
    ]);
    const { service, setStatus } = buildService({ actor: null, task });

    await expect(service.changeStatus('ghost', 'task-1', COMPLETE)).rejects.toBeInstanceOf(
      AccessDeniedException,
    );
    expect(setStatus).not.toHaveBeenCalled();
  });
});
