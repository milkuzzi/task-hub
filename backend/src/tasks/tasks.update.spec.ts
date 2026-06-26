import { AssignmentKind, Prisma, Role, Task, TaskStatus, User } from '@prisma/client';
import {
  AccessDeniedException,
  EntityNotFoundException,
  ValidationException,
} from '../common/errors';
import { AppConfigService } from '../config';
import {
  MessageRepository,
  TaskRepository,
  TaskWithAssignments,
  UserRepository,
} from '../repositories';
import { UpdateTaskDto } from './dto';
import { AuditFieldChange, TaskUpdatedEvent } from './ports';
import { TasksService } from './tasks.service';

/**
 * Модульные тесты {@link TasksService.update} (Req 10.12, 10.13, 20.1) с
 * подменой репозиториев, конфигурации и портов журналирования/уведомлений.
 *
 * Проверяется: сохранение Статуса при правке параметров (Req 10.12), отправка
 * уведомления Исполнителям о правках (Req 10.13), журналирование каждого
 * изменения (Req 20.1), права на редактирование (Менеджер задачи/Администратор,
 * Менеджер-как-Исполнитель не редактирует — Req 2.4), отказ без раскрытия чужой
 * Задачи (Req 2.12) и валидация границ параметров (Req 9.1).
 */

const LIMITS = {
  taskTitleMaxLength: 200,
  taskDescriptionMaxLength: 5000,
  maxAssigneesPerTask: 100,
};

type Assignment = { userId: string; kind: AssignmentKind };

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

function makeTask(overrides: Partial<Task> & { assignments: Assignment[] }): TaskWithAssignments {
  const base: Task = {
    id: 'task-1',
    title: 'Исходное название',
    description: 'Исходное описание',
    deadline: new Date('2030-01-01T10:00:00Z'),
    status: TaskStatus.WAITING,
    adminReviewed: false,
    messageCount: 0,
    createdAt: new Date('2029-12-01T00:00:00Z'),
    doneAt: null,
    updatedAt: new Date('2029-12-01T00:00:00Z'),
  } as unknown as Task;
  const { assignments, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    assignments: assignments.map((a, i) => ({
      id: `a${i}`,
      taskId: base.id,
      userId: a.userId,
      kind: a.kind,
    })),
  } as unknown as TaskWithAssignments;
}

function buildService(opts: { actor: User; task: TaskWithAssignments | null }) {
  const findActiveById = jest.fn(async (id: string) => (id === opts.actor.id ? opts.actor : null));
  const findByIdWithAssignments = jest.fn(async () => opts.task);

  let updateData: Prisma.TaskUpdateInput | undefined;
  const update = jest.fn(async (_id: string, data: Prisma.TaskUpdateInput) => {
    updateData = data;
    // Возвращаем задачу с применёнными полями; Статус берём из текущего (репозиторий
    // не получает статус при правке параметров — Req 10.12).
    return {
      ...(opts.task as unknown as Task),
      ...(data as Partial<Task>),
    } as Task;
  });

  const taskRepository = { findByIdWithAssignments, update } as unknown as TaskRepository;
  const userRepository = { findActiveById } as unknown as UserRepository;
  const config = { limits: LIMITS } as unknown as AppConfigService;

  const record = jest.fn<Promise<void>, [AuditFieldChange]>(async () => undefined);
  const enqueueTaskUpdated = jest.fn<Promise<void>, [TaskUpdatedEvent]>(async () => undefined);

  const service = new TasksService(
    taskRepository,
    userRepository,
    config,
    {} as unknown as MessageRepository,
    { record },
    { enqueueTaskUpdated },
  );

  return { service, update, record, enqueueTaskUpdated, getUpdateData: () => updateData };
}

describe('TasksService.update — сохранение статуса и уведомления (Req 10.12, 10.13)', () => {
  it('изменяет параметры, не меняя Статус (Req 10.12)', async () => {
    const task = makeTask({
      status: TaskStatus.WAITING,
      assignments: [
        { userId: 'mgr', kind: AssignmentKind.MANAGER },
        { userId: 'exe', kind: AssignmentKind.EXECUTOR },
      ],
    });
    const { service, getUpdateData } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    const dto = { title: 'Новое название' } as UpdateTaskDto;
    const updated = await service.update('mgr', 'task-1', dto);

    // Статус сохранён (Req 10.12); поле status не передаётся в репозиторий.
    expect(updated.status).toBe(TaskStatus.WAITING);
    expect(getUpdateData()).toEqual({ title: 'Новое название' });
    expect(getUpdateData()).not.toHaveProperty('status');
  });

  it('ставит уведомление только Исполнителям о правках (Req 10.13)', async () => {
    const task = makeTask({
      assignments: [
        { userId: 'mgr', kind: AssignmentKind.MANAGER },
        { userId: 'exe-1', kind: AssignmentKind.EXECUTOR },
        { userId: 'exe-2', kind: AssignmentKind.EXECUTOR },
      ],
    });
    const { service, enqueueTaskUpdated } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    await service.update('mgr', 'task-1', { title: 'Новое' } as UpdateTaskDto);

    expect(enqueueTaskUpdated).toHaveBeenCalledTimes(1);
    const event = enqueueTaskUpdated.mock.calls[0]![0];
    expect(event.taskId).toBe('task-1');
    expect(event.actorId).toBe('mgr');
    expect([...event.executorIds].sort()).toEqual(['exe-1', 'exe-2']);
    expect(event.changedFields).toEqual(['title']);
  });

  it('журналирует каждое изменённое поле (Req 20.1)', async () => {
    const task = makeTask({
      title: 'Старое',
      description: 'Старое описание',
      deadline: new Date('2030-01-01T10:00:00Z'),
      assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }],
    });
    const { service, record } = buildService({ actor: makeActor('mgr', Role.MANAGER), task });

    await service.update('mgr', 'task-1', {
      title: 'Новое',
      description: 'Новое описание',
      deadline: new Date('2030-02-02T12:00:00Z'),
    } as UpdateTaskDto);

    expect(record).toHaveBeenCalledTimes(3);
    const fields = record.mock.calls.map((c) => c[0].field).sort();
    expect(fields).toEqual(['deadline', 'description', 'title']);
    const titleEntry = record.mock.calls.find((c) => c[0].field === 'title')?.[0];
    expect(titleEntry).toMatchObject({
      taskId: 'task-1',
      authorId: 'mgr',
      oldValue: 'Старое',
      newValue: 'Новое',
    });
  });

  it('очищает Описание в null и журналирует изменение', async () => {
    const task = makeTask({
      description: 'Было',
      assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }],
    });
    const { service, getUpdateData, record } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    await service.update('mgr', 'task-1', { description: null } as UpdateTaskDto);

    expect(getUpdateData()).toEqual({ description: null });
    const entry = record.mock.calls[0]![0];
    expect(entry).toMatchObject({ field: 'description', oldValue: 'Было', newValue: null });
  });

  it('при отсутствии фактических изменений не пишет журнал и не шлёт уведомления', async () => {
    const task = makeTask({
      title: 'Название',
      assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }],
    });
    const { service, update, record, enqueueTaskUpdated } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    // Передаём то же значение Названия — фактического изменения нет.
    const result = await service.update('mgr', 'task-1', { title: 'Название' } as UpdateTaskDto);

    expect(result).toBe(task);
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(enqueueTaskUpdated).not.toHaveBeenCalled();
  });
});

describe('TasksService.update — права и доступ (Req 2.4, 2.12)', () => {
  it('разрешает Администратору изменять параметры (Req 2.3)', async () => {
    const task = makeTask({
      assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }],
    });
    const { service, update } = buildService({ actor: makeActor('adm', Role.ADMIN), task });

    await service.update('adm', 'task-1', { title: 'Изм' } as UpdateTaskDto);

    expect(update).toHaveBeenCalled();
  });

  it('запрещает Исполнителю задачи редактировать (Req 2.4)', async () => {
    const task = makeTask({
      assignments: [{ userId: 'exe', kind: AssignmentKind.EXECUTOR }],
    });
    const { service, update } = buildService({ actor: makeActor('exe', Role.EXECUTOR), task });

    await expect(
      service.update('exe', 'task-1', { title: 'Изм' } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(update).not.toHaveBeenCalled();
  });

  it('запрещает Менеджеру, назначенному Исполнителем, редактировать задачу (Req 2.4)', async () => {
    // Глобальная роль MANAGER, но в этой задаче он назначен Исполнителем.
    const task = makeTask({
      assignments: [{ userId: 'mgr', kind: AssignmentKind.EXECUTOR }],
    });
    const { service, update } = buildService({ actor: makeActor('mgr', Role.MANAGER), task });

    await expect(
      service.update('mgr', 'task-1', { title: 'Изм' } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(AccessDeniedException);
    expect(update).not.toHaveBeenCalled();
  });

  it('не раскрывает недоступную/несуществующую задачу (Req 2.12)', async () => {
    const { service } = buildService({ actor: makeActor('mgr', Role.MANAGER), task: null });

    await expect(
      service.update('mgr', 'missing', { title: 'Изм' } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('отклоняет неактивного инициатора', async () => {
    const task = makeTask({ assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }] });
    const { service } = buildService({ actor: makeActor('mgr', Role.MANAGER), task });

    await expect(
      service.update('ghost', 'task-1', { title: 'Изм' } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(AccessDeniedException);
  });
});

describe('TasksService.update — валидация границ (Req 9.1)', () => {
  it('отклоняет Название длиннее 200 символов и не меняет состояние (Req 9.1)', async () => {
    const task = makeTask({ assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }] });
    const { service, update, record, enqueueTaskUpdated } = buildService({
      actor: makeActor('mgr', Role.MANAGER),
      task,
    });

    await expect(
      service.update('mgr', 'task-1', { title: 'A'.repeat(201) } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(enqueueTaskUpdated).not.toHaveBeenCalled();
  });

  it('отклоняет некорректный Дедлайн (Req 9.1)', async () => {
    const task = makeTask({ assignments: [{ userId: 'mgr', kind: AssignmentKind.MANAGER }] });
    const { service, update } = buildService({ actor: makeActor('mgr', Role.MANAGER), task });

    await expect(
      service.update('mgr', 'task-1', { deadline: new Date('invalid') } as UpdateTaskDto),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(update).not.toHaveBeenCalled();
  });
});
