import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { toNotificationView } from './notification-representation';

function notification(
  overrides: Partial<Notification> & { task?: { title: string } | null } = {},
): Notification & { task?: { title: string } | null } {
  return {
    id: 'notification-1',
    recipientId: 'user-1',
    taskId: 'task-1',
    messageId: null,
    type: NotificationType.TASK_STATUS_CHANGED,
    payload: {},
    isMessageNotification: false,
    siteStatus: DeliveryStatus.PENDING,
    maxStatus: DeliveryStatus.PENDING,
    maxRetryCount: 0,
    createdAt: new Date('2026-06-25T12:00:00.000Z'),
    ...overrides,
  } as Notification & { task?: { title: string } | null };
}

describe('toNotificationView', () => {
  it('does not label task status notifications as chat messages', () => {
    const view = toNotificationView(notification());

    expect(view.type).toBe('STATUS_CHANGED');
    expect(view.title).toBe('Статус задачи изменён');
    expect(view.title).not.toBe('В чате новое сообщение');
  });

  it('builds a detailed status notification body with task title and new status', () => {
    const view = toNotificationView(
      notification({
        task: { title: 'Подготовить отчёт' },
        payload: { status: 'DONE' },
      }),
    );

    expect(view.body).toBe('Задача «Подготовить отчёт». Новый статус: «Выполнено».');
  });

  it('uses payload taskTitle when relation is not loaded and keeps chat context', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.CHAT_MESSAGE,
        isMessageNotification: true,
        messageId: 'message-1',
        payload: {
          taskTitle: 'Задача из payload',
          authorId: 'author-1',
          authorDisplayName: 'Иван Петров',
        },
      }),
    );

    expect(view.title).toBe('В чате новое сообщение');
    expect(view.body).toBe(
      'Задача «Задача из payload». В чате задачи опубликовано новое сообщение от Иван Петров.',
    );
  });

  it('falls back to author id in legacy chat notification payloads', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.CHAT_MESSAGE,
        isMessageNotification: true,
        messageId: 'message-1',
        payload: { taskTitle: 'Задача из payload', authorId: 'author-1' },
      }),
    );

    expect(view.body).toBe(
      'Задача «Задача из payload». В чате задачи опубликовано новое сообщение от участника author-1.',
    );
  });

  it('lists changed task fields in update notifications', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.TASK_FIELD_CHANGED,
        task: { title: 'Проверить договор' },
        payload: { changedFields: ['title', 'deadline'] },
      }),
    );

    expect(view.body).toBe('Задача «Проверить договор». Изменены поля: название, дедлайн.');
  });

  it('describes assignment kind in task assignment notifications', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.TASK_ASSIGNED,
        task: { title: 'Согласовать макет' },
        payload: { kind: 'MANAGER' },
      }),
    );

    expect(view.body).toBe('Задача «Согласовать макет». Вас назначили на задачу как менеджер.');
  });

  it('explains deadline reminder threshold', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.DEADLINE_REMINDER_NEAR,
        task: { title: 'Закрыть релиз' },
        payload: { threshold: 'NEAR' },
      }),
    );

    expect(view.body).toBe(
      'Задача «Закрыть релиз». Приближается дедлайн: ближний порог напоминания.',
    );
  });

  it('describes manager role assignment changes', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.MANAGER_ROLE_CHANGED,
        taskId: null,
        payload: { assigned: true },
      }),
    );

    expect(view.body).toContain('Вам назначена роль Менеджера.');
  });
});
