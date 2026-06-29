import { AssignmentKind, TaskStatus } from '@prisma/client';
import { TaskRepository, TaskWithAssignments } from '../repositories';
import { TaskUpdatedEvent } from '../tasks/ports';
import { TaskNotificationRouter } from './task-notification-router';
import { TaskNotifierAdapter } from './task-notifier.adapter';

/**
 * Юнит-тесты адаптера порта {@link TaskNotifier} (Req 10.13, 13.4).
 *
 * Проверяют, что при изменении параметров Задачи Уведомление формируется
 * Исполнителям И Менеджерам Задачи (Req 13.4), что параметры без Уведомления
 * отфильтровываются, и что недоступная Задача не порождает Уведомления.
 */
function taskWithAssignments(): TaskWithAssignments {
  return {
    id: 'task-1',
    assignments: [
      { id: 'a1', taskId: 'task-1', userId: 'e1', kind: AssignmentKind.EXECUTOR },
      { id: 'a2', taskId: 'task-1', userId: 'e2', kind: AssignmentKind.EXECUTOR },
      { id: 'a3', taskId: 'task-1', userId: 'm1', kind: AssignmentKind.MANAGER },
    ],
  } as unknown as TaskWithAssignments;
}

function createAdapter(task: TaskWithAssignments | null = taskWithAssignments()): {
  adapter: TaskNotifierAdapter;
  notifyFieldsChanged: jest.Mock;
  notifyStatusChanged: jest.Mock;
  notifyAssigned: jest.Mock;
  notifyUnassigned: jest.Mock;
  findByIdWithAssignments: jest.Mock;
} {
  const notifyFieldsChanged = jest.fn().mockResolvedValue(undefined);
  const notifyStatusChanged = jest.fn().mockResolvedValue(undefined);
  const notifyAssigned = jest.fn().mockResolvedValue(undefined);
  const notifyUnassigned = jest.fn().mockResolvedValue(undefined);
  const router = {
    notifyFieldsChanged,
    notifyStatusChanged,
    notifyAssigned,
    notifyUnassigned,
  } as unknown as TaskNotificationRouter;

  const findByIdWithAssignments = jest.fn().mockResolvedValue(task);
  const repo = { findByIdWithAssignments } as unknown as TaskRepository;

  return {
    adapter: new TaskNotifierAdapter(router, repo),
    notifyFieldsChanged,
    notifyStatusChanged,
    notifyAssigned,
    notifyUnassigned,
    findByIdWithAssignments,
  };
}

const baseEvent: TaskUpdatedEvent = {
  taskId: 'task-1',
  actorId: 'mgr',
  executorIds: ['e1', 'e2'],
  changedFields: ['title', 'deadline'],
};

describe('TaskNotifierAdapter.enqueueTaskUpdated', () => {
  it('формирует уведомление Исполнителям И Менеджерам о правках (Req 13.4)', async () => {
    const { adapter, notifyFieldsChanged } = createAdapter();

    await adapter.enqueueTaskUpdated(baseEvent);

    expect(notifyFieldsChanged).toHaveBeenCalledTimes(1);
    const [taskId, changedFields, executorIds, managerIds] = notifyFieldsChanged.mock.calls[0]!;
    expect(taskId).toBe('task-1');
    expect(changedFields).toEqual(['title', 'deadline']);
    expect([...executorIds].sort()).toEqual(['e1', 'e2']);
    expect(managerIds).toEqual(['m1']);
    expect(notifyFieldsChanged.mock.calls[0]![4]).toBeUndefined();
  });

  it('отфильтровывает параметры, не требующие Уведомления', async () => {
    const { adapter, notifyFieldsChanged } = createAdapter();

    await adapter.enqueueTaskUpdated({ ...baseEvent, changedFields: ['status', 'foo'] });

    expect(notifyFieldsChanged).not.toHaveBeenCalled();
  });

  it('пропускает только не-уведомляемые поля, оставляя уведомляемые', async () => {
    const { adapter, notifyFieldsChanged } = createAdapter();

    await adapter.enqueueTaskUpdated({ ...baseEvent, changedFields: ['status', 'title'] });

    expect(notifyFieldsChanged.mock.calls[0]![1]).toEqual(['title']);
  });

  it('не формирует Уведомление для недоступной Задачи', async () => {
    const { adapter, notifyFieldsChanged } = createAdapter(null);

    await adapter.enqueueTaskUpdated(baseEvent);

    expect(notifyFieldsChanged).not.toHaveBeenCalled();
  });
});

describe('TaskNotifierAdapter.enqueueStatusChanged', () => {
  it('delegates the merged recipient inputs and new status to the router', async () => {
    const { adapter, notifyStatusChanged } = createAdapter();

    await adapter.enqueueStatusChanged({
      taskId: 'task-1',
      actorId: 'mgr',
      newStatus: TaskStatus.WAITING,
      executorIds: ['u1', 'u2'],
      managerIds: ['u2', 'u3'],
    });

    expect(notifyStatusChanged).toHaveBeenCalledWith(
      'task-1',
      TaskStatus.WAITING,
      ['u1', 'u2'],
      ['u2', 'u3'],
      undefined,
    );
  });
});

describe('TaskNotifierAdapter assignment events', () => {
  it('delegates assignment notification to the router', async () => {
    const { adapter, notifyAssigned } = createAdapter();

    await (
      adapter as unknown as {
        enqueueTaskAssigned(event: {
          taskId: string;
          userId: string;
          kind: AssignmentKind;
        }): Promise<void>;
      }
    ).enqueueTaskAssigned({
      taskId: 'task-1',
      userId: 'u1',
      kind: AssignmentKind.EXECUTOR,
    });

    expect(notifyAssigned).toHaveBeenCalledWith('task-1', 'u1', AssignmentKind.EXECUTOR, undefined);
  });

  it('delegates unassignment notification to the router', async () => {
    const { adapter, notifyUnassigned } = createAdapter();

    await (
      adapter as unknown as {
        enqueueTaskUnassigned(event: { taskId: string; userId: string }): Promise<void>;
      }
    ).enqueueTaskUnassigned({ taskId: 'task-1', userId: 'u1' });

    expect(notifyUnassigned).toHaveBeenCalledWith('task-1', 'u1', undefined);
  });
});
