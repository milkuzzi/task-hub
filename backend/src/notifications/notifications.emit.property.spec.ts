import fc from 'fast-check';
import { NotificationType, Notification } from '@prisma/client';
import { QueueService, RedisService } from '../infra';
import { NotificationRepository, NotificationCreateData } from './notification.repository';
import { NotificationsService } from './notifications.service';
import { DomainEvent, NotificationChannel } from './notifications.types';

/**
 * **Feature: task-assignment-system, Property 36: Одно событие — отдельные уведомления получателям**
 *
 * Property 36 (см. design.md «Correctness Properties») — **Validates: Requirements 13.1**:
 *
 * Для любого доменного события, требующего уведомления, метод
 * {@link NotificationsService.emit} создаёт по ОДНОМУ отдельному уведомлению на
 * каждого УНИКАЛЬНОГО получателя (без объединения событий в дайджест и без
 * дубликатов): число созданных записей равно числу уникальных получателей, и
 * для каждого уникального получателя создаётся ровно одна запись. Повторный
 * вызов с тем же {@link DomainEvent.eventKey} не порождает дополнительных
 * уведомлений (идемпотентность).
 *
 * Тест использует ин-мемори двойники {@link NotificationRepository} (собирает
 * созданные строки), {@link QueueService} и {@link RedisService} (семантика
 * множества для `setNx`) — без обращения к реальным БД/Redis.
 */

/** Создаёт тестовую запись уведомления с предсказуемым уникальным идентификатором. */
function notificationStub(
  id: string,
  recipientId: string,
  data: NotificationCreateData,
): Notification {
  return {
    id,
    recipientId,
    taskId: data.taskId ?? null,
    messageId: data.messageId ?? null,
    type: data.type,
    payload: data.payload,
    isMessageNotification: data.isMessageNotification ?? false,
    siteStatus: 'PENDING',
    maxStatus: 'PENDING',
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  } as Notification;
}

/**
 * Собирает сервис с ин-мемори двойниками. Двойники переживают несколько вызовов
 * `emit`, что позволяет проверить идемпотентность повторного события.
 */
function buildHarness() {
  const created: NotificationCreateData[] = [];
  let seq = 0;
  const repository = {
    create: jest.fn((data: NotificationCreateData) => {
      created.push(data);
      return Promise.resolve(notificationStub(`notif-${seq++}`, data.recipientId, data));
    }),
  } as unknown as NotificationRepository;

  const enqueued: Array<{ recipientId: string; notificationId: string }> = [];
  const queue = {
    add: jest.fn(
      (_queueName, _jobName, jobData: { recipientId: string; notificationId: string }) => {
        enqueued.push({ recipientId: jobData.recipientId, notificationId: jobData.notificationId });
        return Promise.resolve(undefined);
      },
    ),
  } as unknown as QueueService;

  // Ин-мемори Redis с семантикой множества: setNx захватывает ключ ровно один
  // раз (true при первом захвате, false если уже захвачен); del освобождает.
  const store = new Set<string>();
  const redis = {
    setNx: jest.fn((key: string) => {
      if (store.has(key)) {
        return Promise.resolve(false);
      }
      store.add(key);
      return Promise.resolve(true);
    }),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
  } as unknown as RedisService;

  return { service: new NotificationsService(repository, queue, redis), created, enqueued };
}

// Пул кандидатов-получателей небольшой — это гарантирует появление повторов и
// проверяет дедупликацию в рамках одного события (Req 13.1).
const recipientArb = fc.constantFrom('u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8');

const eventArb: fc.Arbitrary<DomainEvent> = fc
  .record({
    type: fc.constantFrom(...(Object.values(NotificationType) as NotificationType[])),
    recipientIds: fc.array(recipientArb, { minLength: 0, maxLength: 14 }),
    taskId: fc.option(fc.uuid(), { nil: null }),
    payload: fc.record({ status: fc.string(), note: fc.string() }),
    eventKey: fc.string({ minLength: 1, maxLength: 40 }),
    channels: fc.option(
      fc.subarray([NotificationChannel.Site, NotificationChannel.Max], { minLength: 1 }),
      { nil: undefined },
    ),
  })
  .map(({ channels, ...rest }): DomainEvent =>
    // Поле channels опускается, когда канал не задан (по умолчанию сайт + MAX),
    // чтобы соответствовать exactOptionalPropertyTypes.
    channels === undefined ? rest : { ...rest, channels },
  );

describe('NotificationsService.emit — Property 36: одно событие — отдельные уведомления получателям', () => {
  it('создаёт ровно одно уведомление на каждого уникального получателя; повтор по тому же eventKey не добавляет уведомлений (≥100 итераций)', async () => {
    await fc.assert(
      fc.asyncProperty(eventArb, async (event) => {
        const { service, created } = buildHarness();
        const uniqueRecipients = [...new Set(event.recipientIds)];

        await service.emit(event);

        // 1) Число созданных записей равно числу уникальных получателей
        //    (без дайджеста, без дубликатов).
        expect(created).toHaveLength(uniqueRecipients.length);

        // 2) Каждому уникальному получателю соответствует РОВНО одна запись.
        const recipientsOfCreated = created.map((c) => c.recipientId);
        expect(new Set(recipientsOfCreated).size).toBe(recipientsOfCreated.length);
        expect([...new Set(recipientsOfCreated)].sort()).toEqual([...uniqueRecipients].sort());

        // 3) Повторный вызов с тем же ключом события не создаёт новых
        //    уведомлений (идемпотентность по eventKey).
        const countAfterFirst = created.length;
        await service.emit(event);
        expect(created).toHaveLength(countAfterFirst);
      }),
      { numRuns: 200 },
    );
  });
});
