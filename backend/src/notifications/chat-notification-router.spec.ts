import { NotificationType, Notification, Role, User } from '@prisma/client';
import { UserRepository } from '../repositories';
import { NotificationDeliveryService } from './delivery/notification-delivery.service';
import { ChatNotificationRouter } from './chat-notification-router';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';
import { DomainEvent, NotificationChannel } from './notifications.types';

/**
 * Юнит-тесты маршрутизатора Уведомлений по событиям Чата (Req 14.1, 14.2, 14.4,
 * 14.5, 14.7).
 *
 * Проверяется состав получателей Уведомления о новом Сообщении (исключение
 * автора и Администраторов) и очистка Уведомления о Сообщении по факту
 * просмотра (удаление на сайте и в MAX, сохранность прочих типов). Зависимости
 * (обобщённый сервис, репозиторий, сервис доставки, репозиторий пользователей)
 * подменяются моками.
 */
function userStub(id: string, role: Role): User {
  return { id, role } as User;
}

function messageNotificationStub(id: string): Notification {
  return {
    id,
    recipientId: 'u1',
    taskId: 'task-1',
    messageId: 'msg-1',
    type: NotificationType.CHAT_MESSAGE,
    payload: {},
    isMessageNotification: true,
    siteStatus: 'DELIVERED',
    maxStatus: 'DELIVERED',
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  } as Notification;
}

interface Mocks {
  router: ChatNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
  findMessageNotification: jest.Mock;
  deleteById: jest.Mock;
  deleteMessageNotificationInMax: jest.Mock;
  findManyActiveByIds: jest.Mock;
}

function createRouter(overrides?: { users?: User[]; notification?: Notification | null }): Mocks {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;

  const findMessageNotification = jest.fn().mockResolvedValue(overrides?.notification ?? null);
  const deleteById = jest.fn().mockResolvedValue(undefined);
  const repository = {
    findMessageNotification,
    deleteById,
  } as unknown as NotificationRepository;

  const deleteMessageNotificationInMax = jest.fn().mockResolvedValue(true);
  const delivery = {
    deleteMessageNotificationInMax,
  } as unknown as NotificationDeliveryService;

  const findManyActiveByIds = jest.fn().mockResolvedValue(overrides?.users ?? []);
  const users = { findManyActiveByIds } as unknown as UserRepository;

  return {
    router: new ChatNotificationRouter(notifications, repository, delivery, users),
    emit,
    findMessageNotification,
    deleteById,
    deleteMessageNotificationInMax,
    findManyActiveByIds,
  };
}

describe('ChatNotificationRouter.notifyNewMessage', () => {
  it('формирует Уведомление о Сообщении всем участникам, кроме автора (Req 14.1)', async () => {
    const { router, emit } = createRouter({
      users: [
        userStub('e1', Role.EXECUTOR),
        userStub('e2', Role.EXECUTOR),
        userStub('m1', Role.MANAGER),
      ],
    });

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e1', 'e2'],
      managerIds: ['m1'],
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.type).toBe(NotificationType.CHAT_MESSAGE);
    expect(event.isMessageNotification).toBe(true);
    expect(event.channels).toEqual([NotificationChannel.Site, NotificationChannel.Max]);
    expect(event.messageId).toBe('msg-1');
    expect(event.taskId).toBe('task-1');
    expect([...event.recipientIds].sort()).toEqual(['e2', 'm1']);
  });

  it('не отправляет Уведомление о Сообщении Администраторам (Req 14.2)', async () => {
    const { router, emit } = createRouter({
      users: [
        userStub('e1', Role.EXECUTOR),
        userStub('admin-1', Role.ADMIN),
        userStub('m1', Role.MANAGER),
      ],
    });

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e1'],
      managerIds: ['admin-1', 'm1'],
    });

    const event = emit.mock.calls[0]![0];
    expect([...event.recipientIds].sort()).toEqual(['m1']);
  });

  it('не формирует Уведомление, если получателей не осталось (Req 14.1, 14.2)', async () => {
    const { router, emit } = createRouter({
      users: [userStub('admin-1', Role.ADMIN)],
    });

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e1'],
      managerIds: ['admin-1'],
    });

    expect(emit).not.toHaveBeenCalled();
  });

  it('не формирует Уведомление при единственном участнике-авторе (Req 14.1)', async () => {
    const { router, emit, findManyActiveByIds } = createRouter();

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e1'],
      managerIds: [],
    });

    expect(findManyActiveByIds).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('дедуплицирует участника, назначенного и Исполнителем, и Менеджером (Req 14.1)', async () => {
    const { router, emit } = createRouter({
      users: [userStub('u2', Role.EXECUTOR)],
    });

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e1', 'u2'],
      managerIds: ['u2'],
    });

    expect(emit.mock.calls[0]![0].recipientIds).toEqual(['u2']);
  });

  it('использует стабильный ключ идемпотентности по идентификатору Сообщения (Req 13.1)', async () => {
    const { router, emit } = createRouter({ users: [userStub('e2', Role.EXECUTOR)] });

    await router.notifyNewMessage({
      taskId: 'task-1',
      messageId: 'msg-1',
      authorId: 'e1',
      executorIds: ['e2'],
      managerIds: [],
    });

    expect(emit.mock.calls[0]![0].eventKey).toBe('chat-msg:msg-1');
  });

  it('добавляет название задачи и имя автора в подробный payload сообщения', async () => {
    const { router, emit } = createRouter({ users: [userStub('e2', Role.EXECUTOR)] });

    await router.notifyNewMessage({
      taskId: 'task-1',
      taskTitle: 'Подготовить отчёт',
      messageId: 'msg-1',
      authorId: 'e1',
      authorDisplayName: 'Иван Петров',
      executorIds: ['e2'],
      managerIds: [],
    });

    expect(emit.mock.calls[0]![0].payload).toEqual({
      authorId: 'e1',
      taskTitle: 'Подготовить отчёт',
      authorDisplayName: 'Иван Петров',
    });
  });
});

describe('ChatNotificationRouter.clearMessageNotification', () => {
  it('удаляет Уведомление о Сообщении на сайте и в MAX по просмотру (Req 14.4)', async () => {
    const notification = messageNotificationStub('notif-1');
    const { router, deleteMessageNotificationInMax, deleteById } = createRouter({ notification });

    await router.clearMessageNotification('u1', 'msg-1');

    expect(deleteMessageNotificationInMax).toHaveBeenCalledWith(notification);
    expect(deleteById).toHaveBeenCalledWith('notif-1');
  });

  it('удаляет Уведомление на сайте даже при неуспехе удаления в MAX (Req 14.7)', async () => {
    const notification = messageNotificationStub('notif-1');
    const { router, deleteMessageNotificationInMax, deleteById } = createRouter({ notification });
    deleteMessageNotificationInMax.mockResolvedValue(false);

    await router.clearMessageNotification('u1', 'msg-1');

    expect(deleteById).toHaveBeenCalledWith('notif-1');
  });

  it('идемпотентна и не трогает прочие типы при отсутствии Уведомления о Сообщении (Req 14.5)', async () => {
    const { router, deleteMessageNotificationInMax, deleteById } = createRouter({
      notification: null,
    });

    await router.clearMessageNotification('u1', 'msg-1');

    expect(deleteMessageNotificationInMax).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
  });
});
