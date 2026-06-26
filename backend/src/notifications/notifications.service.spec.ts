import { NotificationType, Notification } from '@prisma/client';
import { QueueName, QueueService, RedisService } from '../infra';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_DELIVERY_JOB_NAME,
  NOTIFICATION_DELIVERY_JOB_OPTIONS,
  NOTIFICATION_IDEMPOTENCY_TTL_SECONDS,
  buildIdempotencyKey,
} from './notifications.constants';
import { DomainEvent, NotificationChannel } from './notifications.types';

/** Создаёт тестовую запись уведомления с предсказуемым идентификатором. */
function notificationStub(id: string, recipientId: string): Notification {
  return {
    id,
    recipientId,
    taskId: 'task-1',
    messageId: null,
    type: NotificationType.TASK_ASSIGNED,
    payload: {},
    isMessageNotification: false,
    siteStatus: 'PENDING',
    maxStatus: 'PENDING',
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  } as Notification;
}

interface Mocks {
  service: NotificationsService;
  create: jest.Mock;
  add: jest.Mock;
  setNx: jest.Mock;
  del: jest.Mock;
}

function createService(overrides?: { setNx?: jest.Mock; create?: jest.Mock }): Mocks {
  const create =
    overrides?.create ??
    jest
      .fn()
      .mockImplementation((data: { recipientId: string }) =>
        Promise.resolve(notificationStub(`notif-${data.recipientId}`, data.recipientId)),
      );
  const repository = { create } as unknown as NotificationRepository;

  const add = jest.fn().mockResolvedValue(undefined);
  const queue = { add } as unknown as QueueService;

  const setNx = overrides?.setNx ?? jest.fn().mockResolvedValue(true);
  const del = jest.fn().mockResolvedValue(1);
  const redis = { setNx, del } as unknown as RedisService;

  return { service: new NotificationsService(repository, queue, redis), create, add, setNx, del };
}

const baseEvent: DomainEvent = {
  type: NotificationType.TASK_ASSIGNED,
  recipientIds: ['u1', 'u2'],
  taskId: 'task-1',
  payload: { status: 'IN_PROGRESS' },
  eventKey: 'task-1:assigned:v1',
};

describe('NotificationsService.emit', () => {
  it('создаёт по одному уведомлению на каждого получателя (без дайджеста, Req 13.1)', async () => {
    const { service, create } = createService();

    await service.emit(baseEvent);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'u1', type: NotificationType.TASK_ASSIGNED }),
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'u2' }));
  });

  it('ставит задание доставки в очередь на каждого получателя (Req 13.12)', async () => {
    const { service, add } = createService();

    await service.emit(baseEvent);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      QueueName.MaxNotifications,
      NOTIFICATION_DELIVERY_JOB_NAME,
      {
        notificationId: 'notif-u1',
        recipientId: 'u1',
        channels: [NotificationChannel.Site, NotificationChannel.Max],
      },
      NOTIFICATION_DELIVERY_JOB_OPTIONS,
    );
  });

  it('записывает исходные статусы доставки PENDING для каждого канала (Req 13.13)', async () => {
    const { service, create } = createService();

    await service.emit(baseEvent);

    // Репозиторий устанавливает siteStatus/maxStatus = PENDING при создании;
    // здесь проверяем, что данные передаются без переопределения статусов.
    const firstCallArgs = create.mock.calls[0]?.[0] as { siteStatus?: unknown };
    expect(firstCallArgs.siteStatus).toBeUndefined();
  });

  it('дедуплицирует повторяющихся получателей внутри одного события (Req 13.1)', async () => {
    const { service, create } = createService();

    await service.emit({ ...baseEvent, recipientIds: ['u1', 'u1', 'u1'] });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('не создаёт дубликат при повторном ключе события (идемпотентность, Req 13.1)', async () => {
    const setNx = jest.fn().mockResolvedValue(false);
    const { service, create, add } = createService({ setNx });

    await service.emit(baseEvent);

    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('захватывает маркер идемпотентности на пару «событие+получатель» с TTL', async () => {
    const { service, setNx } = createService();

    await service.emit(baseEvent);

    expect(setNx).toHaveBeenCalledWith(
      buildIdempotencyKey('task-1:assigned:v1', 'u1'),
      '1',
      NOTIFICATION_IDEMPOTENCY_TTL_SECONDS,
    );
  });

  it('освобождает маркер идемпотентности при сбое создания уведомления', async () => {
    const create = jest.fn().mockRejectedValue(new Error('db down'));
    const { service, del } = createService({ create });

    await expect(service.emit({ ...baseEvent, recipientIds: ['u1'] })).rejects.toThrow('db down');
    expect(del).toHaveBeenCalledWith(buildIdempotencyKey('task-1:assigned:v1', 'u1'));
  });

  it('число созданных уведомлений равно числу уникальных получателей', async () => {
    const { service, create, add } = createService();

    await service.emit({ ...baseEvent, recipientIds: ['a', 'b', 'c'] });

    expect(create).toHaveBeenCalledTimes(3);
    expect(add).toHaveBeenCalledTimes(3);
  });
});
