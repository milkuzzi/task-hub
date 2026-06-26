import fc from 'fast-check';
import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { QueueService, RedisService } from '../../infra';
import { NotificationRepository } from '../notification.repository';
import { NotificationChannel } from '../notifications.types';
import { MaxDeliveryFilter } from './max-delivery-filter';
import { MaxDeliveryPort } from './max-delivery.port';
import { NotificationDeliveryService } from './notification-delivery.service';
import { SiteNotificationDispatcher } from './site-notification.dispatcher';

/**
 * **Feature: task-assignment-system, Property 42: Независимость доставки на сайт от канала MAX**
 *
 * Validates: Requirements 14.6, 14.7, 15.7, 16.13
 *
 * Для любого уведомления доставка/сохранение на сайте выполняется независимо от
 * результата доставки в канал MAX. Каким бы ни был исход доставки в MAX (успех,
 * неуспех, исключение/недоступность сервиса) и сколько бы попыток ни было
 * выполнено, сайт всегда доставляется и фиксируется как `siteStatus=DELIVERED`
 * и НИКОГДА не откатывается из-за сбоев MAX.
 */

/** Все типы уведомлений, для которых сервис выполняет доставку по каналам. */
const NOTIFICATION_TYPES: readonly NotificationType[] = [
  NotificationType.CHAT_MESSAGE,
  NotificationType.MANAGER_ROLE_CHANGED,
  NotificationType.ADMIN_TRANSFER,
  NotificationType.ACCOUNT_REGISTRATION,
  NotificationType.TASK_ASSIGNED,
  NotificationType.TASK_UNASSIGNED,
  NotificationType.TASK_FIELD_CHANGED,
  NotificationType.TASK_STATUS_CHANGED,
  NotificationType.TASK_REOPENED,
  NotificationType.TASK_CANCELLED,
  NotificationType.TASK_RETURNED,
  NotificationType.DEADLINE_REMINDER_FAR,
  NotificationType.DEADLINE_REMINDER_NEAR,
];

/** Возможный исход доставки в канал MAX (произвольный по произвольным попыткам). */
type MaxOutcome = 'success' | 'failure' | 'unavailable' | 'throw';

/** Создаёт тестовую запись уведомления с сайтом, ещё не доставленным. */
function notificationStub(overrides: Partial<Notification>): Notification {
  return {
    id: 'notif-1',
    recipientId: 'user-1',
    taskId: 'task-1',
    messageId: null,
    type: NotificationType.TASK_STATUS_CHANGED,
    payload: { status: 'DONE' },
    isMessageNotification: false,
    siteStatus: DeliveryStatus.PENDING,
    maxStatus: DeliveryStatus.PENDING,
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as Notification;
}

interface UpdateCall {
  id: string;
  data: Partial<Notification>;
}

/**
 * Собирает сервис с замоканными зависимостями. `MaxDeliveryPort` управляется
 * произвольным исходом доставки, обновления репозитория захватываются.
 */
function createHarness(notification: Notification, maxOutcome: MaxOutcome) {
  const updateCalls: UpdateCall[] = [];
  const findById = jest.fn().mockResolvedValue(notification);
  const update = jest.fn(async (id: string, data: Partial<Notification>) => {
    updateCalls.push({ id, data });
    return notification;
  });
  const repository = { findById, update } as unknown as NotificationRepository;

  const add = jest.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as QueueService;

  const pushToUser = jest.fn().mockReturnValue(true);
  const site = { pushToUser } as unknown as SiteNotificationDispatcher;

  const set = jest.fn().mockResolvedValue(undefined);
  const redis = { set } as unknown as RedisService;

  const deliverNotification = jest.fn(async () => {
    switch (maxOutcome) {
      case 'success':
        return { delivered: true };
      case 'failure':
        return { delivered: false, reason: 'MAX отклонил доставку' };
      case 'unavailable':
        return { delivered: false, reason: 'Сервис MAX недоступен' };
      case 'throw':
        throw new Error('Сбой соединения с Ботом MAX');
    }
  });
  const deleteMessageNotification = jest.fn().mockResolvedValue({ delivered: false });
  const maxPort = { deliverNotification, deleteMessageNotification } as unknown as MaxDeliveryPort;

  // Фильтр отписок/заглушения не подавляет доставку: проверяем именно
  // независимость сайта от исхода доставки в MAX.
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
  return { service, updateCalls, pushToUser };
}

describe('NotificationDeliveryService — Property 42: независимость доставки на сайт от MAX', () => {
  it('сайт всегда доставлен (siteStatus=DELIVERED) при любом исходе MAX и не откатывается', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NotificationType>(...NOTIFICATION_TYPES),
        fc.integer({ min: 0, max: 5 }),
        fc.constantFrom<DeliveryStatus>(DeliveryStatus.PENDING, DeliveryStatus.RETRY),
        fc.constantFrom<MaxOutcome>('success', 'failure', 'unavailable', 'throw'),
        fc.uuid(),
        fc.uuid(),
        async (type, maxRetryCount, initialMaxStatus, maxOutcome, notifId, recipientId) => {
          const notification = notificationStub({
            id: notifId,
            recipientId,
            type,
            maxRetryCount,
            siteStatus: DeliveryStatus.PENDING,
            maxStatus: initialMaxStatus,
          });
          const { service, updateCalls, pushToUser } = createHarness(notification, maxOutcome);

          // Доставка по обоим каналам; сбой MAX (включая исключение) не должен
          // влиять на уже выполненную доставку на сайт.
          await service
            .deliver({
              notificationId: notifId,
              recipientId,
              channels: [NotificationChannel.Site, NotificationChannel.Max],
            })
            .catch(() => {
              // Исключение MAX-канала допустимо: сайт уже доставлен ранее.
            });

          // 1. Сайт доставлен: realtime-push в персональную комнату получателя.
          expect(pushToUser).toHaveBeenCalledWith(
            recipientId,
            expect.objectContaining({ id: notifId }),
          );

          // 2. siteStatus зафиксирован как DELIVERED ровно один раз.
          const siteUpdates = updateCalls.filter((c) => 'siteStatus' in c.data);
          expect(siteUpdates).toHaveLength(1);
          expect(siteUpdates[0]).toEqual({
            id: notifId,
            data: { siteStatus: DeliveryStatus.DELIVERED },
          });

          // 3. Сайт никогда не откатывается из-за MAX: ни одно обновление не
          //    переводит siteStatus в значение, отличное от DELIVERED.
          for (const call of updateCalls) {
            if ('siteStatus' in call.data) {
              expect(call.data.siteStatus).toBe(DeliveryStatus.DELIVERED);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
