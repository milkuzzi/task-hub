import { Injectable, Logger } from '@nestjs/common';
import { Notification } from '@prisma/client';

/**
 * Результат операции доставки/удаления уведомления через Бот MAX.
 */
export interface MaxDeliveryResult {
  /** `true`, если операция в MAX выполнена успешно. */
  delivered: boolean;
  /** Необязательная причина неуспеха (для диагностики/логирования). */
  reason?: string;
}

/**
 * Порт внешней доставки уведомлений через Бот MAX (Req 13.13, 14.6, 14.7, 15.7).
 *
 * Абстрагирует фактическую интеграцию с MAX (Бот/HTTP API), которая
 * реализуется в задаче 13.x ({@link import('../../').MaxIntegrationModule}).
 * Воркер доставки уведомлений (задача 12.10) зависит только от этого порта, что
 * позволяет реализовать и протестировать политику ретраев и независимость
 * доставки на сайт независимо от готовности интеграции MAX.
 *
 * В штатном модуле к токену {@link MAX_DELIVERY_PORT} привязан HTTP-адаптер
 * Bot API MAX. {@link UnavailableMaxDeliveryAdapter} оставлен как безопасная
 * резервная реализация для тестов/локальных сборок без подключённого Бота:
 * уведомление доставляется и сохраняется на сайте, а доставка в MAX переходит
 * к ретраям и, по их исчерпании, фиксируется как неуспешная.
 */
export interface MaxDeliveryPort {
  /**
   * Доставляет уведомление получателю через Бот MAX.
   *
   * @param notification Запись уведомления для доставки.
   * @returns Результат доставки {@link MaxDeliveryResult}.
   */
  deliverNotification(notification: Notification): Promise<MaxDeliveryResult>;

  /**
   * Удаляет ранее доставленное уведомление о Сообщении в Боте MAX (Req 14.7,
   * 16.12) — например, после просмотра Сообщения Пользователем.
   *
   * @param notification Запись уведомления о Сообщении.
   * @returns Результат удаления {@link MaxDeliveryResult}.
   */
  deleteMessageNotification(notification: Notification): Promise<MaxDeliveryResult>;
}

/**
 * DI-токен порта {@link MaxDeliveryPort}.
 *
 * В {@link import('../notifications.module').NotificationsModule} связан с
 * продуктовым адаптером MAX, не затрагивая воркер доставки.
 */
export const MAX_DELIVERY_PORT = Symbol('MAX_DELIVERY_PORT');

/**
 * Безопасная реализация-заглушка {@link MaxDeliveryPort} до подключения
 * интеграции MAX (задача 13.x).
 *
 * Сообщает о недоступности Бота MAX для любой операции: доставка считается
 * неуспешной (что корректно запускает политику ретраев и фиксацию итогового
 * статуса по Req 13.13, 14.6, 15.7), а удаление уведомления — неуспешным (что
 * фиксирует признак для повторной попытки по Req 14.7). При этом доставка и
 * сохранение уведомления на сайте выполняются независимо (Req 14.6, 15.7).
 */
@Injectable()
export class UnavailableMaxDeliveryAdapter implements MaxDeliveryPort {
  private readonly logger = new Logger(UnavailableMaxDeliveryAdapter.name);

  private static readonly REASON = 'Интеграция с Ботом MAX ещё не подключена (задача 13.x).';

  async deliverNotification(notification: Notification): Promise<MaxDeliveryResult> {
    this.logger.debug(
      `Доставка уведомления «${notification.id}» через Бот MAX пропущена: ` +
        UnavailableMaxDeliveryAdapter.REASON,
    );
    return { delivered: false, reason: UnavailableMaxDeliveryAdapter.REASON };
  }

  async deleteMessageNotification(notification: Notification): Promise<MaxDeliveryResult> {
    this.logger.debug(
      `Удаление уведомления «${notification.id}» в Боте MAX пропущено: ` +
        UnavailableMaxDeliveryAdapter.REASON,
    );
    return { delivered: false, reason: UnavailableMaxDeliveryAdapter.REASON };
  }
}
