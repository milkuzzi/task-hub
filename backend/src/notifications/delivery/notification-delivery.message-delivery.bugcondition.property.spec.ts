import fc from 'fast-check';
import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { QueueService, RedisService } from '../../infra';
import { NotificationRepository } from '../notification.repository';
import { toNotificationView } from '../notification-representation';
import { NotificationChannel } from '../notifications.types';
import { MaxDeliveryFilter } from './max-delivery-filter';
import { MaxDeliveryPort } from './max-delivery.port';
import { NotificationDeliveryService } from './notification-delivery.service';
import { SiteNotificationDispatcher } from './site-notification.dispatcher';

/**
 * **Bugfix: task-hub-bug-fixes — Property 5 (Bug Condition): доставка
 * Уведомления получателю в форме контракта `AppNotification`**
 *
 * **Validates: Requirements 1.3, 2.3**
 *
 * Exploratory-тест условия дефекта 3 (`isBugCondition_3`). Получатель R —
 * не автор и не Администратор Сообщения Чата — подключён по сокету. При новом
 * Сообщении сервис доставки выполняет realtime-push в персональную комнату R
 * через {@link SiteNotificationDispatcher.pushToUser}. Полезная нагрузка этого
 * push перехватывается мок-диспетчером.
 *
 * Property 5 требует, чтобы живая сокет-нагрузка соответствовала контракту
 * `AppNotification` (`frontend/src/lib/notifications-api.ts`): поля `id`,
 * фронтенд-`type`, `isMessageNotification`, `taskId`, `messageId`, `title`,
 * `body`, `createdAt` (ISO-8601), `siteStatus`, `maxStatus`. Эталоном корректной
 * формы служит {@link toNotificationView}, через который формируется запись,
 * доступная в Центре уведомлений (REST).
 *
 * **CRITICAL (методология bugfix)**: тест ДОЛЖЕН ПАДАТЬ на неисправленном коде —
 * падение подтверждает дефект. `NotificationDeliveryService.buildSitePayload`
 * отдаёт `{ id, type (сырой доменный enum), taskId, messageId, payload,
 * isMessageNotification, createdAt }` — без `title`/`body`, без приведённых
 * `siteStatus`/`maxStatus` и с сырым доменным `type` (`CHAT_MESSAGE` вместо
 * `NEW_MESSAGE`). Поэтому нагрузка не соответствует `AppNotification`.
 * **DO NOT** чинить тест или код при падении — падение ожидаемо.
 */

/** Поля контракта `AppNotification`, обязательные в живой сокет-нагрузке. */
const APP_NOTIFICATION_KEYS = [
  'id',
  'type',
  'isMessageNotification',
  'taskId',
  'messageId',
  'title',
  'body',
  'createdAt',
  'siteStatus',
  'maxStatus',
] as const;

/** Допустимые фронтенд-типы контракта `AppNotification`. */
const FRONTEND_TYPES = [
  'TASK_ASSIGNED',
  'TASK_UNASSIGNED',
  'TASK_UPDATED',
  'STATUS_CHANGED',
  'TASK_REOPENED',
  'TASK_CANCELLED',
  'TASK_RETURNED',
  'DEADLINE_REMINDER',
  'ROLE_CHANGED',
  'NEW_MESSAGE',
] as const;

/** Создаёт запись Уведомления о Сообщении Чата для получателя R. */
function chatMessageNotificationStub(overrides: Partial<Notification>): Notification {
  return {
    id: 'notif-1',
    recipientId: 'recipient-R',
    taskId: 'task-1',
    messageId: 'message-1',
    type: NotificationType.CHAT_MESSAGE,
    payload: { authorName: 'Менеджер М' },
    isMessageNotification: true,
    siteStatus: DeliveryStatus.PENDING,
    maxStatus: DeliveryStatus.PENDING,
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as Notification;
}

/**
 * Собирает сервис с замоканными зависимостями. Перехватывает полезную нагрузку,
 * переданную в realtime-push получателю.
 */
function createHarness(notification: Notification) {
  const findById = jest.fn().mockResolvedValue(notification);
  const update = jest.fn().mockResolvedValue(notification);
  const repository = { findById, update } as unknown as NotificationRepository;

  const add = jest.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as QueueService;

  let capturedPayload: unknown;
  let capturedUserId: string | undefined;
  const pushToUser = jest.fn((userId: string, payload: unknown) => {
    capturedUserId = userId;
    capturedPayload = payload;
    return true;
  });
  const site = { pushToUser } as unknown as SiteNotificationDispatcher;

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
  return {
    service,
    getPayload: (): Record<string, unknown> => capturedPayload as Record<string, unknown>,
    getUserId: (): string | undefined => capturedUserId,
  };
}

describe('Property 5 (Bug Condition): живая сокет-нагрузка Уведомления соответствует AppNotification (Req 1.3, 2.3)', () => {
  it('доставляет получателю R нагрузку в форме контракта AppNotification и запись доступна в Центре', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        async (notifId, recipientId, taskId, messageId) => {
          // Условие дефекта 3: получатель R — не автор и не Администратор —
          // подключён по сокету; событие — новое Сообщение Чата.
          const notification = chatMessageNotificationStub({
            id: notifId,
            recipientId,
            taskId,
            messageId,
            type: NotificationType.CHAT_MESSAGE,
          });
          const h = createHarness(notification);

          await h.service.deliver({
            notificationId: notifId,
            recipientId,
            channels: [NotificationChannel.Site],
          });

          const payload = h.getPayload();

          // Push выполнен в персональную комнату получателя R.
          expect(h.getUserId()).toBe(recipientId);
          expect(payload).toBeDefined();

          // Property 5: нагрузка соответствует контракту AppNotification.
          // (1) Присутствуют все поля контракта и нет лишних (сырой `payload`).
          expect(Object.keys(payload).sort()).toEqual([...APP_NOTIFICATION_KEYS].sort());

          // (2) Локализованные на сервере title/body заполнены.
          expect(typeof payload.title).toBe('string');
          expect((payload.title as string).length).toBeGreaterThan(0);
          expect(typeof payload.body).toBe('string');
          expect((payload.body as string).length).toBeGreaterThan(0);

          // (3) Тип приведён к перечислению фронтенда (NEW_MESSAGE), а не сырой
          //     доменный enum CHAT_MESSAGE.
          expect(FRONTEND_TYPES).toContain(payload.type as string);
          expect(payload.type).toBe('NEW_MESSAGE');

          // (4) Статусы доставки приведены к фронтенд-перечислению.
          expect(['PENDING', 'DELIVERED', 'FAILED']).toContain(payload.siteStatus as string);
          expect(['PENDING', 'DELIVERED', 'FAILED']).toContain(payload.maxStatus as string);

          // (5) Момент формирования сериализован в ISO-8601 (строка), а не Date.
          expect(typeof payload.createdAt).toBe('string');

          // (6) Прочие поля контракта совпадают с эталоном записи Центра
          //     (REST через toNotificationView).
          const centerView = toNotificationView(notification);
          expect(payload.id).toBe(centerView.id);
          expect(payload.taskId).toBe(centerView.taskId);
          expect(payload.messageId).toBe(centerView.messageId);
          expect(payload.isMessageNotification).toBe(centerView.isMessageNotification);

          // (7) Нагрузка целиком эквивалентна представлению Центра уведомлений.
          expect(payload).toEqual(centerView as unknown as Record<string, unknown>);
        },
      ),
      { numRuns: 100 },
    );
  });
});
