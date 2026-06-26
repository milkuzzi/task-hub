import fc from 'fast-check';
import { DeliveryStatus, Notification, NotificationType, Role, User } from '@prisma/client';
import { QueueService, RedisService } from '../../infra';
import { UserRepository } from '../../repositories';
import { ChatNotificationRouter } from '../chat-notification-router';
import { toNotificationView } from '../notification-representation';
import { NotificationRepository } from '../notification.repository';
import { NotificationsService } from '../notifications.service';
import { DomainEvent, NotificationChannel } from '../notifications.types';
import { MaxDeliveryFilter } from './max-delivery-filter';
import { MaxDeliveryPort } from './max-delivery.port';
import { NotificationDeliveryService } from './notification-delivery.service';
import { SiteNotificationDispatcher } from './site-notification.dispatcher';

/**
 * **Bugfix: task-hub-bug-fixes — Property 6 (Preservation): исключение
 * автора/Администраторов и офлайн-доставка Уведомления о Сообщении**
 *
 * **Validates: Requirements 3.3, 3.4**
 *
 * Preservation-тест по методологии «сначала наблюдение». Дефект 3 устраняется
 * точечно — фикс (задача 9) меняет ТОЛЬКО форму живой сокет-нагрузки в
 * {@link NotificationDeliveryService.buildSitePayload} (через
 * {@link toNotificationView}). Поведение для входов ¬C должно остаться
 * неизменным:
 *
 * - **Исключение получателей (Req 3.4 → Req 14.1, 14.2)**: автор Сообщения и
 *   любой Администратор НЕ являются получателями Уведомления о Сообщении Чата.
 *   Состав получателей вычисляет {@link ChatNotificationRouter.notifyNewMessage}
 *   как `(Исполнители ∪ Менеджеры) − автор − Администраторы`.
 * - **Офлайн-доставка (Req 3.3)**: при отсутствии живого соединения
 *   (realtime-push не доставлен) запись Уведомления всё равно сохраняется в БД
 *   со статусом сайта `DELIVERED` и доступна в Центре уведомлений (REST через
 *   {@link toNotificationView}) при следующем входе.
 *
 * **EXPECTED OUTCOME**: тесты ПРОХОДЯТ на неисправленном коде (фиксируют базовое
 * поведение ¬C для предотвращения регрессий).
 */

/** Все роли системы — для генерации профилей кандидатов в получатели. */
const ROLES: readonly Role[] = [Role.EXECUTOR, Role.MANAGER, Role.ADMIN];

/** Профиль кандидата: идентификатор, роль и принадлежность к Участникам Задачи. */
interface Participant {
  id: string;
  role: Role;
  isExecutor: boolean;
  isManager: boolean;
}

/** Создаёт маршрутизатор Уведомлений Чата с подменёнными зависимостями. */
function createRouter(activeUsers: readonly User[]): {
  router: ChatNotificationRouter;
  emit: jest.Mock<Promise<void>, [DomainEvent]>;
} {
  const emit = jest.fn<Promise<void>, [DomainEvent]>().mockResolvedValue(undefined);
  const notifications = { emit } as unknown as NotificationsService;
  const repository = {} as unknown as NotificationRepository;
  const delivery = {} as unknown as NotificationDeliveryService;

  const byId = new Map(activeUsers.map((u) => [u.id, u]));
  const findManyActiveByIds = jest
    .fn<Promise<User[]>, [readonly string[]]>()
    .mockImplementation((ids) =>
      Promise.resolve(ids.map((id) => byId.get(id)).filter((u): u is User => u !== undefined)),
    );
  const users = { findManyActiveByIds } as unknown as UserRepository;

  return {
    router: new ChatNotificationRouter(notifications, repository, delivery, users),
    emit,
  };
}

/** Создаёт запись Уведомления о Сообщении Чата для офлайн-получателя. */
function chatMessageNotificationStub(overrides: Partial<Notification>): Notification {
  return {
    id: 'notif-1',
    recipientId: 'recipient-R',
    taskId: 'task-1',
    messageId: 'message-1',
    type: NotificationType.CHAT_MESSAGE,
    payload: { authorId: 'author-A' },
    isMessageNotification: true,
    siteStatus: DeliveryStatus.PENDING,
    maxStatus: DeliveryStatus.PENDING,
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as Notification;
}

/**
 * Собирает сервис доставки с РЕАЛЬНЫМ {@link SiteNotificationDispatcher} без
 * зарегистрированного Gateway — это моделирует отсутствие живого соединения у
 * получателя (realtime-push возвращает `false`). Захватывает последнее обновление
 * записи в БД (`siteStatus`).
 */
function createOfflineHarness(notification: Notification) {
  const findById = jest.fn().mockResolvedValue(notification);
  const update = jest
    .fn()
    .mockImplementation((_id: string, patch: Partial<Notification>) =>
      Promise.resolve({ ...notification, ...patch }),
    );
  const repository = { findById, update } as unknown as NotificationRepository;

  const add = jest.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as QueueService;

  // Реальный диспетчер без bind(): notifier === null → pushToUser → false
  // (нет живого соединения). Шпионим за вызовом push.
  const site = new SiteNotificationDispatcher();
  const pushSpy = jest.spyOn(site, 'pushToUser');

  const set = jest.fn().mockResolvedValue(undefined);
  const redis = { set } as unknown as RedisService;

  const deliverNotification = jest.fn().mockResolvedValue({ delivered: true });
  const deleteMessageNotification = jest.fn().mockResolvedValue({ delivered: true });
  const maxPort = { deliverNotification, deleteMessageNotification } as unknown as MaxDeliveryPort;

  const isSuppressed = jest.fn().mockResolvedValue(false);
  const maxFilter = { isSuppressed } as unknown as MaxDeliveryFilter;

  const service = new NotificationDeliveryService(
    repository,
    queue,
    site,
    redis,
    maxPort,
    maxFilter,
  );
  return { service, update, pushSpy };
}

describe('Property 6 (Preservation): исключение автора/Администраторов (Req 3.4 → 14.1, 14.2)', () => {
  it('автор и Администраторы НЕ попадают в получатели Уведомления о Сообщении', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 })
          .chain((ids) =>
            fc.record({
              participants: fc.tuple(
                ...ids.map((id) =>
                  fc.record({
                    id: fc.constant(id),
                    role: fc.constantFrom(...ROLES),
                    membership: fc.constantFrom('executor', 'manager', 'both'),
                  }),
                ),
              ),
              authorIndex: fc.integer({ min: 0, max: ids.length - 1 }),
            }),
          ),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        async (gen, taskId, messageId) => {
          const participants: Participant[] = gen.participants.map((p) => ({
            id: p.id,
            role: p.role,
            isExecutor: p.membership === 'executor' || p.membership === 'both',
            isManager: p.membership === 'manager' || p.membership === 'both',
          }));

          const authorId = participants[gen.authorIndex]!.id;
          const executorIds = participants.filter((p) => p.isExecutor).map((p) => p.id);
          const managerIds = participants.filter((p) => p.isManager).map((p) => p.id);
          const activeUsers: User[] = participants.map((p) => ({ id: p.id, role: p.role }) as User);

          const { router, emit } = createRouter(activeUsers);
          await router.notifyNewMessage({ taskId, messageId, authorId, executorIds, managerIds });

          const adminIds = new Set(
            participants.filter((p) => p.role === Role.ADMIN).map((p) => p.id),
          );

          if (!emit.mock.calls.length) {
            // Получателей не осталось — Уведомление не формируется. Базовое
            // поведение ¬C (Req 14.1, 14.2) сохранено.
            return;
          }

          const event = emit.mock.calls[0]![0];
          const recipients = new Set(event.recipientIds);

          // Preservation (Req 3.4): автор исключён (Req 14.1)...
          expect(recipients.has(authorId)).toBe(false);
          // ...и ни один Администратор не является получателем (Req 14.2).
          for (const adminId of adminIds) {
            expect(recipients.has(adminId)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 6 (Preservation): офлайн-доставка сохраняет запись в Центре (Req 3.3)', () => {
  it('при отсутствии живого соединения запись сохраняется со siteStatus=DELIVERED и доступна в Центре', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        async (notifId, recipientId, taskId, messageId) => {
          const notification = chatMessageNotificationStub({
            id: notifId,
            recipientId,
            taskId,
            messageId,
            type: NotificationType.CHAT_MESSAGE,
          });
          const h = createOfflineHarness(notification);

          await h.service.deliver({
            notificationId: notifId,
            recipientId,
            channels: [NotificationChannel.Site],
          });

          // Получатель офлайн: realtime-push выполнен best-effort и не доставлен
          // (Gateway не зарегистрирован → pushToUser вернул false).
          expect(h.pushSpy).toHaveBeenCalledWith(recipientId, expect.anything());
          expect(h.pushSpy).toHaveReturnedWith(false);

          // Preservation (Req 3.3): запись Уведомления всё равно сохранена в БД
          // со статусом сайта DELIVERED — она доступна в Центре уведомлений
          // независимо от наличия живого соединения.
          expect(h.update).toHaveBeenCalledWith(notifId, {
            siteStatus: DeliveryStatus.DELIVERED,
          });

          // Запись доступна в Центре в форме контракта AppNotification (REST).
          const centerView = toNotificationView(notification);
          expect(centerView.id).toBe(notifId);
          expect(centerView.taskId).toBe(taskId);
          expect(centerView.messageId).toBe(messageId);
          expect(centerView.isMessageNotification).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
