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

  it('uses related task title as notification body', () => {
    const view = toNotificationView(notification({ task: { title: 'Подготовить отчёт' } }));

    expect(view.body).toBe('Подготовить отчёт');
  });

  it('uses payload taskTitle when relation is not loaded', () => {
    const view = toNotificationView(
      notification({
        type: NotificationType.CHAT_MESSAGE,
        isMessageNotification: true,
        messageId: 'message-1',
        payload: { taskTitle: 'Задача из payload' },
      }),
    );

    expect(view.title).toBe('В чате новое сообщение');
    expect(view.body).toBe('Задача из payload');
  });
});
