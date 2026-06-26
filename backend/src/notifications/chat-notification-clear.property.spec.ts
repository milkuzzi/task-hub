import fc from 'fast-check';
import { DeliveryStatus, Notification, NotificationType } from '@prisma/client';
import { UserRepository } from '../repositories';
import { NotificationDeliveryService } from './delivery/notification-delivery.service';
import { ChatNotificationRouter } from './chat-notification-router';
import { NotificationRepository } from './notification.repository';
import { NotificationsService } from './notifications.service';

/**
 * **Feature: task-assignment-system, Property 41: Очистка уведомлений о сообщениях после просмотра и сохранность прочих**
 *
 * Property 41 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 14.4, 14.5, 16.12**:
 *
 * Для любого Пользователя после отметки Сообщения просмотренным (на сайте или в
 * Боте MAX) соответствующее Уведомление о Сообщении удаляется по всем каналам
 * (удаление на сайте + попытка удаления в MAX, Req 14.4, 16.12), при этом
 * Уведомления любых иных типов по факту просмотра НЕ удаляются (Req 14.5).
 *
 * {@link ChatNotificationRouter.clearMessageNotification} запускается против
 * стейтового in-memory {@link NotificationRepository}, наполненного смесью
 * Уведомлений о Сообщениях ({@link Notification.isMessageNotification} = `true`)
 * и Уведомлений прочих типов. {@link NotificationDeliveryService} подменяется
 * моком, фиксирующим вызовы `deleteMessageNotificationInMax`. Обращений к
 * реальной БД/Redis/MAX нет.
 *
 * Ровно одно свойство.
 */

/** Уведомления о Сообщениях бывают только типа CHAT_MESSAGE. */
const MESSAGE_TYPE = NotificationType.CHAT_MESSAGE;

/** Прочие (не-сообщенческие) типы Уведомлений — никогда не удаляются по просмотру (Req 14.5). */
const OTHER_TYPES: readonly NotificationType[] = [
  NotificationType.TASK_ASSIGNED,
  NotificationType.TASK_UNASSIGNED,
  NotificationType.TASK_FIELD_CHANGED,
  NotificationType.TASK_STATUS_CHANGED,
  NotificationType.TASK_REOPENED,
  NotificationType.DEADLINE_REMINDER_FAR,
  NotificationType.DEADLINE_REMINDER_NEAR,
  NotificationType.MANAGER_ROLE_CHANGED,
  NotificationType.ADMIN_TRANSFER,
  NotificationType.ACCOUNT_REGISTRATION,
];

/** Небольшие пулы — гарантируют пересечения получателей и Сообщений между записями. */
const userArb = fc.constantFrom('u1', 'u2', 'u3', 'u4');
const messageArb = fc.constantFrom('m1', 'm2', 'm3', 'm4');

/** Спецификация одной записи Уведомления, из которой собирается стейт репозитория. */
interface NotifSpec {
  recipientId: string;
  /** Уведомление о Сообщении (true) или Уведомление прочего типа (false). */
  isMessage: boolean;
  /** Идентификатор Сообщения; присутствует всегда у сообщенческих и иногда у прочих. */
  messageId: string;
  /** Тип прочего Уведомления (для не-сообщенческих записей). */
  otherType: NotificationType;
}

const notifSpecArb: fc.Arbitrary<NotifSpec> = fc.record({
  recipientId: userArb,
  isMessage: fc.boolean(),
  messageId: messageArb,
  otherType: fc.constantFrom(...OTHER_TYPES),
});

/** Преобразует спецификацию в полноценную запись Notification с уникальным id. */
function buildNotification(spec: NotifSpec, index: number): Notification {
  return {
    id: `notif-${index}`,
    recipientId: spec.recipientId,
    taskId: 'task-1',
    // Прочие типы тоже могут иметь messageId (например, относиться к Чату задачи),
    // что делает тест строгим: фильтр обязан опираться на isMessageNotification.
    messageId: spec.messageId,
    type: spec.isMessage ? MESSAGE_TYPE : spec.otherType,
    payload: {},
    isMessageNotification: spec.isMessage,
    siteStatus: DeliveryStatus.DELIVERED,
    maxStatus: DeliveryStatus.DELIVERED,
    maxRetryCount: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
  } as Notification;
}

/** Стейтовый in-memory репозиторий: воспроизводит findMessageNotification + deleteById. */
function createStatefulRepository(store: Notification[]): NotificationRepository {
  return {
    // Возвращает первое Уведомление о Сообщении (isMessageNotification=true) для пары
    // «получатель + Сообщение» — повторяет семантику findFirst продакшен-репозитория.
    findMessageNotification: (recipientId: string, messageId: string) =>
      Promise.resolve(
        store.find(
          (n) =>
            n.recipientId === recipientId &&
            n.messageId === messageId &&
            n.isMessageNotification === true,
        ) ?? null,
      ),
    deleteById: (id: string) => {
      const idx = store.findIndex((n) => n.id === id);
      if (idx >= 0) {
        store.splice(idx, 1);
      }
      return Promise.resolve();
    },
  } as unknown as NotificationRepository;
}

describe('ChatNotificationRouter — Property 41: очистка уведомлений о сообщениях после просмотра и сохранность прочих', () => {
  it('просмотр удаляет ТОЛЬКО соответствующее Уведомление о Сообщении (сайт + MAX), прочие сохраняются (≥100 итераций)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(notifSpecArb, { maxLength: 10 }),
        userArb,
        messageArb,
        fc.boolean(),
        async (specs, viewerId, viewedMessageId, maxDeleteSucceeds) => {
          const store = specs.map((spec, index) => buildNotification(spec, index));
          const before = store.map((n) => ({ ...n }));

          const repository = createStatefulRepository(store);

          const deleteMessageNotificationInMax = jest.fn().mockResolvedValue(maxDeleteSucceeds);
          const delivery = {
            deleteMessageNotificationInMax,
          } as unknown as NotificationDeliveryService;

          const router = new ChatNotificationRouter(
            {} as unknown as NotificationsService,
            repository,
            delivery,
            {} as unknown as UserRepository,
          );

          // Ожидаемая цель очистки: первое Уведомление о Сообщении для пары
          // «просмотревший + просмотренное Сообщение» (Req 14.4).
          const target = before.find(
            (n) =>
              n.recipientId === viewerId &&
              n.messageId === viewedMessageId &&
              n.isMessageNotification === true,
          );

          await router.clearMessageNotification(viewerId, viewedMessageId);

          if (target === undefined) {
            // Нет совпадающего Уведомления о Сообщении — состояние неизменно,
            // канал MAX не задействован (идемпотентность, Req 14.5).
            expect(deleteMessageNotificationInMax).not.toHaveBeenCalled();
            expect(store.map((n) => n.id).sort()).toEqual(before.map((n) => n.id).sort());
            return;
          }

          // 1) Цель удалена по каналу MAX (попытка удаления, Req 14.4, 16.12)…
          expect(deleteMessageNotificationInMax).toHaveBeenCalledTimes(1);
          expect(deleteMessageNotificationInMax).toHaveBeenCalledWith(
            expect.objectContaining({ id: target.id }),
          );

          // 2) …и на сайте — независимо от результата удаления в MAX (Req 14.4, 14.7).
          expect(store.some((n) => n.id === target.id)).toBe(false);

          // 3) Все ОСТАЛЬНЫЕ Уведомления сохранены без изменений (Req 14.5):
          const expectedRemaining = before.filter((n) => n.id !== target.id);
          expect(store.map((n) => n.id).sort()).toEqual(expectedRemaining.map((n) => n.id).sort());

          // 4) Ни одно Уведомление ПРОЧЕГО типа не удалено по факту просмотра (Req 14.5):
          for (const original of before) {
            if (!original.isMessageNotification) {
              expect(store.some((n) => n.id === original.id)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
