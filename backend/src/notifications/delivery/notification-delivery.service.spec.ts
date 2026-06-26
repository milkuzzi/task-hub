import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { QueueName, QueueService, RedisService } from '../../infra';
import { NotificationRepository } from '../notification.repository';
import {
  NOTIFICATION_DELIVERY_JOB_NAME,
  buildMaxDeletionRetryKey,
} from '../notifications.constants';
import { NotificationChannel } from '../notifications.types';
import { MaxDeliveryFilter } from './max-delivery-filter';
import { MaxDeliveryPort } from './max-delivery.port';
import { NotificationDeliveryService } from './notification-delivery.service';
import { SiteNotificationDispatcher } from './site-notification.dispatcher';
import { MAX_DELIVERY_MAX_ATTEMPTS, MESSAGE_RETRY_INTERVAL_MS } from './delivery-policy';

/** Создаёт тестовую запись уведомления. */
function notificationStub(overrides: Partial<Notification> = {}): Notification {
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

interface Harness {
  service: NotificationDeliveryService;
  findById: jest.Mock;
  update: jest.Mock;
  add: jest.Mock;
  pushToUser: jest.Mock;
  set: jest.Mock;
  deliverNotification: jest.Mock;
  deleteMessageNotification: jest.Mock;
  isSuppressed: jest.Mock;
}

function createHarness(options?: {
  notification?: Notification | null;
  maxDelivered?: boolean;
  maxDeleted?: boolean;
  suppressed?: boolean;
}): Harness {
  const notification =
    options !== undefined && 'notification' in options ? options.notification : notificationStub();
  const findById = jest.fn().mockResolvedValue(notification);
  const update = jest.fn().mockResolvedValue(notification);
  const repository = { findById, update } as unknown as NotificationRepository;

  const add = jest.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as QueueService;

  const pushToUser = jest.fn().mockReturnValue(true);
  const site = { pushToUser } as unknown as SiteNotificationDispatcher;

  const set = jest.fn().mockResolvedValue(undefined);
  const redis = { set } as unknown as RedisService;

  const deliverNotification = jest
    .fn()
    .mockResolvedValue({ delivered: options?.maxDelivered ?? false });
  const deleteMessageNotification = jest
    .fn()
    .mockResolvedValue({ delivered: options?.maxDeleted ?? false });
  const maxPort = { deliverNotification, deleteMessageNotification } as unknown as MaxDeliveryPort;

  const isSuppressed = jest.fn().mockResolvedValue(options?.suppressed ?? false);
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
    findById,
    update,
    add,
    pushToUser,
    set,
    deliverNotification,
    deleteMessageNotification,
    isSuppressed,
  };
}

const bothChannels = [NotificationChannel.Site, NotificationChannel.Max];

describe('NotificationDeliveryService.deliver', () => {
  it('доставляет на сайт и фиксирует siteStatus=DELIVERED (Req 14.6)', async () => {
    const h = createHarness({ maxDelivered: true });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: bothChannels,
    });

    expect(h.pushToUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: 'notif-1' }));
    expect(h.update).toHaveBeenCalledWith('notif-1', { siteStatus: DeliveryStatus.DELIVERED });
  });

  it('сохраняет сайт независимо от сбоя MAX (Req 14.6, 15.7)', async () => {
    const h = createHarness({ maxDelivered: false });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: bothChannels,
    });

    // siteStatus DELIVERED зафиксирован, несмотря на неуспех MAX.
    expect(h.update).toHaveBeenCalledWith('notif-1', { siteStatus: DeliveryStatus.DELIVERED });
  });

  it('фиксирует maxStatus=DELIVERED при успехе MAX', async () => {
    const h = createHarness({ maxDelivered: true });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: [NotificationChannel.Max],
    });

    expect(h.update).toHaveBeenCalledWith('notif-1', { maxStatus: DeliveryStatus.DELIVERED });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('при сбое MAX переводит в RETRY, инкрементирует счётчик и ставит отложенный ретрай', async () => {
    const h = createHarness({
      notification: notificationStub({ type: NotificationType.CHAT_MESSAGE, maxRetryCount: 0 }),
      maxDelivered: false,
    });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: [NotificationChannel.Max],
    });

    expect(h.update).toHaveBeenCalledWith('notif-1', {
      maxStatus: DeliveryStatus.RETRY,
      maxRetryCount: 1,
    });
    expect(h.add).toHaveBeenCalledWith(
      QueueName.MaxNotifications,
      NOTIFICATION_DELIVERY_JOB_NAME,
      {
        notificationId: 'notif-1',
        recipientId: 'user-1',
        channels: [NotificationChannel.Max],
      },
      expect.objectContaining({ delay: MESSAGE_RETRY_INTERVAL_MS }),
    );
  });

  it('по исчерпании попыток фиксирует maxStatus=FAILED без ретрая (Req 13.13)', async () => {
    const h = createHarness({
      notification: notificationStub({ maxRetryCount: MAX_DELIVERY_MAX_ATTEMPTS - 1 }),
      maxDelivered: false,
    });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: [NotificationChannel.Max],
    });

    expect(h.update).toHaveBeenCalledWith('notif-1', {
      maxStatus: DeliveryStatus.FAILED,
      maxRetryCount: MAX_DELIVERY_MAX_ATTEMPTS,
    });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('не доставляет повторно уже доставленный на сайт канал', async () => {
    const h = createHarness({
      notification: notificationStub({ siteStatus: DeliveryStatus.DELIVERED }),
      maxDelivered: true,
    });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: [NotificationChannel.Site],
    });

    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('подавляет доставку в MAX при отписке/заглушении и фиксирует maxStatus=SKIPPED (Req 16.5, 16.6, 16.9)', async () => {
    const h = createHarness({ suppressed: true });

    await h.service.deliver({
      notificationId: 'notif-1',
      recipientId: 'user-1',
      channels: [NotificationChannel.Max],
    });

    expect(h.isSuppressed).toHaveBeenCalled();
    expect(h.deliverNotification).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith('notif-1', { maxStatus: DeliveryStatus.SKIPPED });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('пропускает задание для несуществующего уведомления', async () => {
    const h = createHarness({ notification: null });

    await h.service.deliver({
      notificationId: 'missing',
      recipientId: 'user-1',
      channels: bothChannels,
    });

    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.deliverNotification).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('NotificationDeliveryService.deleteMessageNotificationInMax', () => {
  it('возвращает true и не фиксирует признак при успешном удалении в MAX', async () => {
    const h = createHarness({ maxDeleted: true });
    const notification = notificationStub({ type: NotificationType.CHAT_MESSAGE });

    const result = await h.service.deleteMessageNotificationInMax(notification);

    expect(result).toBe(true);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('при неудаче фиксирует признак повторной попытки удаления (Req 14.7)', async () => {
    const h = createHarness({ maxDeleted: false });
    const notification = notificationStub({ id: 'notif-9', type: NotificationType.CHAT_MESSAGE });

    const result = await h.service.deleteMessageNotificationInMax(notification);

    expect(result).toBe(false);
    expect(h.set).toHaveBeenCalledWith(
      buildMaxDeletionRetryKey('notif-9'),
      '1',
      expect.any(Number),
    );
  });
});
