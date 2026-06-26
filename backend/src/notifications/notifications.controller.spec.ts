import { DeliveryStatus, Notification, NotificationType, Role } from '@prisma/client';
import { AccessDeniedException, EntityNotFoundException } from '../common/errors';
import { AuthenticatedRequest, SessionAuthGuard } from '../auth';
import { ChatNotificationRouter } from './chat-notification-router';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Контроллерные тесты {@link NotificationsController} (задача 7.2).
 *
 * Проверяют тонкую маршрутизацию HTTP → {@link NotificationsService} /
 * {@link ChatNotificationRouter}: возврат только собственных Уведомлений
 * текущего Пользователя (Req 7.1, 7.4), очистку Уведомления о Сообщении по
 * просмотру делегированием в маршрутизатор Чата (Req 7.2, 14.4), скрытие с
 * проверкой владения (Req 7.3, 7.4), коды 204 и наличие гарда сессии (Req 1.5).
 * Сами доменные правила и владение проверяются в тестах сервиса/репозитория;
 * здесь моделируется только поведение контроллера.
 */
describe('NotificationsController', () => {
  const USER_ID = 'user-1';
  const NOW = new Date('2026-06-19T10:00:00.000Z');

  function makeNotification(overrides: Partial<Notification> = {}): Notification {
    return {
      id: 'notif-1',
      recipientId: USER_ID,
      taskId: 'task-1',
      messageId: null,
      type: NotificationType.TASK_ASSIGNED,
      payload: {},
      isMessageNotification: false,
      siteStatus: DeliveryStatus.PENDING,
      maxStatus: DeliveryStatus.PENDING,
      maxRetryCount: 0,
      createdAt: NOW,
      ...overrides,
    } as Notification;
  }

  function buildController(opts: { userId?: string } = {}): {
    controller: NotificationsController;
    service: jest.Mocked<Pick<NotificationsService, 'listForRecipient' | 'dismiss'>>;
    chatNotifications: jest.Mocked<Pick<ChatNotificationRouter, 'clearMessageNotification'>>;
    req: AuthenticatedRequest;
  } {
    const service = {
      listForRecipient: jest.fn().mockResolvedValue([makeNotification()]),
      dismiss: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<NotificationsService, 'listForRecipient' | 'dismiss'>>;

    const chatNotifications = {
      clearMessageNotification: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Pick<ChatNotificationRouter, 'clearMessageNotification'>>;

    const controller = new NotificationsController(
      service as unknown as NotificationsService,
      chatNotifications as unknown as ChatNotificationRouter,
    );
    const req = {
      user: { userId: opts.userId ?? USER_ID, tokenId: 't1', role: Role.EXECUTOR },
    } as AuthenticatedRequest;

    return { controller, service, chatNotifications, req };
  }

  it('возвращает только собственные Уведомления текущего Пользователя (Req 7.1, 7.4)', async () => {
    const { controller, service, req } = buildController();
    const list = await controller.list(req);
    expect(service.listForRecipient).toHaveBeenCalledWith(USER_ID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'notif-1',
      type: 'TASK_ASSIGNED',
      isMessageNotification: false,
      taskId: 'task-1',
      messageId: null,
      createdAt: NOW.toISOString(),
      siteStatus: 'PENDING',
      maxStatus: 'PENDING',
    });
    expect(typeof list[0]?.title).toBe('string');
    expect(typeof list[0]?.body).toBe('string');
  });

  it('сопоставляет доменные типы и статусы доставки с перечислениями фронтенда', async () => {
    const { controller, service, req } = buildController();
    service.listForRecipient.mockResolvedValueOnce([
      makeNotification({
        type: NotificationType.CHAT_MESSAGE,
        isMessageNotification: true,
        messageId: 'message-9',
        siteStatus: DeliveryStatus.DELIVERED,
        maxStatus: DeliveryStatus.RETRY,
      }),
    ]);
    const list = await controller.list(req);
    expect(list[0]).toMatchObject({
      type: 'NEW_MESSAGE',
      isMessageNotification: true,
      messageId: 'message-9',
      title: 'В чате новое сообщение',
      siteStatus: 'DELIVERED',
      maxStatus: 'PENDING',
    });
  });

  it('очищает Уведомление о Сообщении по просмотру через маршрутизатор Чата (Req 7.2, 14.4)', async () => {
    const { controller, chatNotifications, req } = buildController();
    await controller.seen({ messageId: 'message-9' }, req);
    expect(chatNotifications.clearMessageNotification).toHaveBeenCalledWith(USER_ID, 'message-9');
  });

  it('скрывает Уведомление текущего Пользователя по идентификатору (Req 7.3)', async () => {
    const { controller, service, req } = buildController();
    await controller.dismiss('notif-1', req);
    expect(service.dismiss).toHaveBeenCalledWith(USER_ID, 'notif-1');
  });

  it('пробрасывает «не найдено» при скрытии чужого/несуществующего Уведомления (Req 7.4, 2.12)', async () => {
    const { controller, service, req } = buildController({ userId: 'outsider-1' });
    service.dismiss.mockRejectedValueOnce(new EntityNotFoundException('Уведомление не найдено.'));
    await expect(controller.dismiss('notif-1', req)).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('отклоняет запрос без аутентифицированного субъекта (Req 1.5)', async () => {
    const { controller } = buildController();
    const anonymous = {} as AuthenticatedRequest;
    await expect(controller.list(anonymous)).rejects.toBeInstanceOf(AccessDeniedException);
  });

  it('возвращает 204 на очистку по просмотру и скрытие (Req 7.2, 7.3)', () => {
    const seenCode = Reflect.getMetadata('__httpCode__', NotificationsController.prototype.seen);
    const dismissCode = Reflect.getMetadata(
      '__httpCode__',
      NotificationsController.prototype.dismiss,
    );
    expect(seenCode).toBe(204);
    expect(dismissCode).toBe(204);
  });

  it('SessionAuthGuard объявлен на контроллере (Req 1.5)', () => {
    const guards = Reflect.getMetadata('__guards__', NotificationsController) as unknown[];
    expect(guards).toContain(SessionAuthGuard);
  });
});
