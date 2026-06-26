import { Injectable, Logger } from '@nestjs/common';

/**
 * Колбэк адресной доставки уведомления на сайт (в персональную комнату
 * Пользователя). Реализуется ChatGateway поверх Socket.IO.
 */
export type SiteNotifier = (userId: string, payload: unknown) => void;

/**
 * Порт адресной доставки уведомлений на сайт (Req 13, 14.6, 15.7).
 *
 * Складывается из двух частей: (1) сохранение записи уведомления в БД, которое
 * делает уведомление доступным в центре уведомлений независимо от наличия
 * живого соединения, и (2) realtime-доставка через Socket.IO в персональную
 * комнату Пользователя. Доступность уведомления на сайте НЕ зависит от
 * результата доставки в MAX (Req 14.6, 15.7).
 *
 * Чтобы избежать циклической зависимости модулей (Chat → Tasks → Notifications),
 * воркер доставки обращается к этому диспетчеру, а ChatGateway регистрирует в
 * нём функцию доставки при инициализации через {@link SiteNotificationDispatcher.bind}.
 * Схема повторяет приём
 * {@link import('../../auth/session-disconnector').SocketSessionDisconnector}.
 *
 * До регистрации (например, при использовании NotificationsModule без Gateway)
 * realtime-доставка пропускается; корректность не нарушается, так как запись
 * уведомления уже сохранена в БД и доступна на сайте.
 */
@Injectable()
export class SiteNotificationDispatcher {
  private readonly logger = new Logger(SiteNotificationDispatcher.name);

  /** Функция realtime-доставки; `null`, пока Gateway её не зарегистрировал. */
  private notifier: SiteNotifier | null = null;

  /**
   * Регистрирует функцию realtime-доставки уведомлений на сайт. Вызывается
   * ChatGateway при инициализации (`afterInit`).
   *
   * @param notifier Колбэк доставки уведомления Пользователю.
   */
  bind(notifier: SiteNotifier): void {
    this.notifier = notifier;
  }

  /**
   * Доставляет уведомление Пользователю на сайт (best-effort realtime-push).
   *
   * Возвращает `true`, если realtime-доставка выполнена, и `false`, если
   * Gateway ещё не зарегистрирован или доставка не удалась. В любом случае
   * доступность уведомления на сайте обеспечивается сохранённой записью в БД,
   * поэтому результат push не влияет на итоговый статус сайта (Req 14.6, 15.7).
   *
   * @param userId Идентификатор получателя.
   * @param payload Полезная нагрузка уведомления.
   */
  pushToUser(userId: string, payload: unknown): boolean {
    if (this.notifier === null) {
      this.logger.debug(
        `Realtime-доставка уведомления Пользователю «${userId}» пропущена: ` +
          'Gateway ещё не зарегистрирован (уведомление доступно на сайте из БД).',
      );
      return false;
    }
    try {
      this.notifier(userId, payload);
      return true;
    } catch (error) {
      this.logger.warn(
        `Не удалось доставить уведомление Пользователю «${userId}» по сокету: ${String(error)}`,
      );
      return false;
    }
  }
}
