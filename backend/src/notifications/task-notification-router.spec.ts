import { AssignmentKind, NotificationType, ReminderThreshold, TaskStatus } from '@prisma/client';
import { ClockService } from '../clock';
import { NotificationsService } from './notifications.service';
import { DomainEvent } from './notifications.types';
import { TaskNotificationRouter } from './task-notification-router';

/**
 * Юнит-тесты маршрутизатора Уведомлений по событиям Задачи (Req 13.2–13.6,
 * 13.11, 15.5, 15.6, 13.5, 14.3, 15.9, 15.10).
 *
 * Маршрутизатор проверяется на корректность типа Уведомления, состава
 * получателей, полезной нагрузки и каналов; обобщённый сервис формирования
 * уведомлений подменяется моком.
 */
function createRouter(now = new Date('2024-01-01T00:00:00.000Z')): {
  router: TaskNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
} {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;
  const clock = { now: () => now } as unknown as ClockService;
  return { router: new TaskNotificationRouter(notifications, clock), emit };
}

function lastEvent(emit: jest.Mock<Promise<void>, [DomainEvent]>): DomainEvent {
  return emit.mock.calls[emit.mock.calls.length - 1]![0];
}

describe('TaskNotificationRouter', () => {
  it('уведомляет назначенного Пользователя (Req 13.2)', async () => {
    const { router, emit } = createRouter();

    await router.notifyAssigned('task-1', 'u1', AssignmentKind.EXECUTOR);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = lastEvent(emit);
    expect(event.type).toBe(NotificationType.TASK_ASSIGNED);
    expect(event.recipientIds).toEqual(['u1']);
    expect(event.taskId).toBe('task-1');
    expect(event.payload).toEqual({ kind: AssignmentKind.EXECUTOR });
  });

  it('уведомляет снятого Пользователя (Req 13.3)', async () => {
    const { router, emit } = createRouter();

    await router.notifyUnassigned('task-1', 'u2');

    const event = lastEvent(emit);
    expect(event.type).toBe(NotificationType.TASK_UNASSIGNED);
    expect(event.recipientIds).toEqual(['u2']);
  });

  it('уведомляет Исполнителей И Менеджеров об изменении параметров (Req 13.4)', async () => {
    const { router, emit } = createRouter();

    await router.notifyFieldsChanged('task-1', ['title', 'deadline'], ['e1', 'e2'], ['m1']);

    const event = lastEvent(emit);
    expect(event.type).toBe(NotificationType.TASK_FIELD_CHANGED);
    expect([...event.recipientIds].sort()).toEqual(['e1', 'e2', 'm1']);
    expect(event.payload).toEqual({ changedFields: ['title', 'deadline'] });
  });

  it('не формирует уведомление об изменении параметров без получателей или изменений (Req 13.4)', async () => {
    const { router, emit } = createRouter();

    await router.notifyFieldsChanged('task-1', ['title'], [], []);
    await router.notifyFieldsChanged('task-1', [], ['e1'], ['m1']);

    expect(emit).not.toHaveBeenCalled();
  });

  it('уведомляет Исполнителей и Менеджеров о смене Статуса с новым Статусом (Req 13.6)', async () => {
    const { router, emit } = createRouter();

    await router.notifyStatusChanged('task-1', TaskStatus.DONE, ['e1'], ['m1']);

    const event = lastEvent(emit);
    expect(event.type).toBe(NotificationType.TASK_STATUS_CHANGED);
    expect([...event.recipientIds].sort()).toEqual(['e1', 'm1']);
    expect(event.payload).toEqual({ status: TaskStatus.DONE });
  });

  it('добавляет название Задачи в напоминание о Дедлайне', async () => {
    const { router, emit } = createRouter();

    await router.notifyDeadlineReminder(
      'task-1',
      ReminderThreshold.NEAR,
      ['e1'],
      ['m1'],
      'Сдать отчёт',
    );

    const event = lastEvent(emit);
    expect(event.type).toBe(NotificationType.DEADLINE_REMINDER_NEAR);
    expect([...event.recipientIds].sort()).toEqual(['e1', 'm1']);
    expect(event.payload).toEqual({ threshold: 'NEAR', taskTitle: 'Сдать отчёт' });
  });

  it('уведомляет о переоткрытии/отмене/возврате (Req 13.11)', async () => {
    const { router, emit } = createRouter();

    await router.notifyReopened('task-1', ['e1'], ['m1']);
    await router.notifyCancelled('task-1', ['e1'], ['m1']);
    await router.notifyReturned('task-1', ['e1'], ['m1']);

    expect(emit.mock.calls.map((c) => c[0].type)).toEqual([
      NotificationType.TASK_REOPENED,
      NotificationType.TASK_CANCELLED,
      NotificationType.TASK_RETURNED,
    ]);
    for (const call of emit.mock.calls) {
      expect([...call[0].recipientIds].sort()).toEqual(['e1', 'm1']);
    }
  });

  it('уведомляет Пользователя о назначении и снятии роли Менеджера (Req 15.5, 15.6)', async () => {
    const { router, emit } = createRouter();

    await router.notifyManagerRoleChanged('u1', true);
    await router.notifyManagerRoleChanged('u1', false);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      type: NotificationType.MANAGER_ROLE_CHANGED,
      recipientIds: ['u1'],
      payload: { assigned: true },
    });
    expect(emit.mock.calls[1]![0].payload).toEqual({ assigned: false });
  });

  it('объединяет получателей без повторов (Req 13.4, 13.6, 13.11)', async () => {
    const { router, emit } = createRouter();

    await router.notifyStatusChanged('task-1', TaskStatus.WAITING, ['u1', 'u2'], ['u2', 'u3']);

    expect([...lastEvent(emit).recipientIds].sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('строит различающиеся ключи событий для разных наступлений (Req 13.1)', async () => {
    const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
    const notifications = { emit } as unknown as NotificationsService;
    let tick = 0;
    const clock = { now: () => new Date(1_000 + tick++) } as unknown as ClockService;
    const router = new TaskNotificationRouter(notifications, clock);

    await router.notifyStatusChanged('task-1', TaskStatus.DONE, ['e1'], []);
    await router.notifyStatusChanged('task-1', TaskStatus.DONE, ['e1'], []);

    expect(emit.mock.calls[0]![0].eventKey).not.toBe(emit.mock.calls[1]![0].eventKey);
  });

  describe('исключённые события не формируют Уведомлений', () => {
    it('изменение состава участников (Req 13.5)', async () => {
      const { router, emit } = createRouter();
      await router.onParticipantsChanged();
      expect(emit).not.toHaveBeenCalled();
    });

    it('изменение профиля Администратором (Req 15.9)', async () => {
      const { router, emit } = createRouter();
      await router.onAdminProfileChanged();
      expect(emit).not.toHaveBeenCalled();
    });

    it('удаление учётной записи (Req 15.10)', async () => {
      const { router, emit } = createRouter();
      await router.onAccountDeleted();
      expect(emit).not.toHaveBeenCalled();
    });

    it('изменение/удаление Сообщения (Req 14.3)', async () => {
      const { router, emit } = createRouter();
      await router.onMessageEditedOrDeleted();
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
