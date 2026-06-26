import { Injectable } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { ChatMuteRepository, UserRepository } from '../../repositories';

/**
 * Подмножество полей Уведомления, по которым принимается решение о фильтрации
 * доставки через Бот MAX. Используется как для записей {@link Notification},
 * так и для упрощённых тестовых объектов.
 */
export type MaxDeliveryTarget = Pick<Notification, 'recipientId' | 'taskId'>;

/**
 * Фильтр доставки Уведомлений через Бот MAX по отпискам и заглушению
 * (Req 16.5, 16.6, 16.9, 16.13).
 *
 * Применяется в пути доставки в MAX ({@link import('./notification-delivery.service').NotificationDeliveryService})
 * ДО фактической отправки через {@link import('./max-delivery.port').MaxDeliveryPort}.
 * Решение зависит исключительно от состояния отписок/заглушения получателя и не
 * затрагивает доставку и сохранение Уведомления на сайте (Req 16.13):
 *
 * - **Полная отписка** (`MaxLink.mutedAll = true`) подавляет доставку любых
 *   Уведомлений этому Пользователю через Бот MAX до повторного включения
 *   (Req 16.5).
 * - **Отписка от Задачи / заглушение Чата Задачи** (наличие записи
 *   {@link import('@prisma/client').ChatMute} для пары «получатель + Задача»)
 *   подавляет доставку Уведомлений этой Задачи через Бот MAX (Req 16.6, 16.9).
 *
 * Если у получателя нет привязки MAX либо ни одно условие подавления не
 * выполнено, фильтр не подавляет доставку — дальнейшее поведение (включая
 * случай недоступного/непривязанного Бота) определяет порт доставки.
 */
@Injectable()
export class MaxDeliveryFilter {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly chatMuteRepository: ChatMuteRepository,
  ) {}

  /**
   * Сообщает, подавлена ли доставка Уведомления через Бот MAX для его
   * получателя (Req 16.5, 16.6, 16.9).
   *
   * @param notification Уведомление (используются получатель и связанная Задача).
   * @returns `true`, если доставку в MAX следует подавить; иначе `false`.
   */
  async isSuppressed(notification: MaxDeliveryTarget): Promise<boolean> {
    // Полная отписка от всех Уведомлений через Бот MAX (Req 16.5).
    const link = await this.userRepository.findMaxLinkByUserId(notification.recipientId);
    if (link !== null && link.mutedAll) {
      return true;
    }

    // Отписка от конкретной Задачи / заглушение её Чата (Req 16.6, 16.9).
    if (notification.taskId !== null && notification.taskId !== undefined) {
      const muted = await this.chatMuteRepository.isMuted(
        notification.recipientId,
        notification.taskId,
      );
      if (muted) {
        return true;
      }
    }

    return false;
  }
}
