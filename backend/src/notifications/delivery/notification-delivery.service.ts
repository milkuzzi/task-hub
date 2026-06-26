import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, Notification } from '@prisma/client';
import { QueueName, QueueService, RedisService } from '../../infra';
import {
  NOTIFICATION_DELIVERY_JOB_NAME,
  NOTIFICATION_DELIVERY_JOB_OPTIONS,
  NOTIFICATION_MAX_DELETION_RETRY_TTL_SECONDS,
  buildMaxDeletionRetryKey,
} from '../notifications.constants';
import { NotificationView, toNotificationView } from '../notification-representation';
import { NotificationRepository } from '../notification.repository';
import { NotificationChannel, NotificationDeliveryJobData } from '../notifications.types';
import { decideMaxDeliveryOnFailure } from './delivery-policy';
import { MaxDeliveryFilter } from './max-delivery-filter';
import { MAX_DELIVERY_PORT, MaxDeliveryPort } from './max-delivery.port';
import { SiteNotificationDispatcher } from './site-notification.dispatcher';

/**
 * Сервис доставки уведомлений по каналам (сайт + Бот MAX) с ретраями и
 * независимостью сайта от MAX (Req 13.13, 14.6, 14.7, 15.4, 15.7).
 *
 * Вызывается воркером очереди {@link QueueName.MaxNotifications} (задача 12.10)
 * для каждого задания доставки, поставленного
 * {@link import('../notifications.service').NotificationsService.emit}. Логика
 * доставки:
 *
 * 1. **Сайт.** Если запрошен канал {@link NotificationChannel.Site} и сайт ещё
 *    не доставлен, выполняется realtime-push в персональную комнату
 *    Пользователя и фиксируется `siteStatus = DELIVERED`. Доступность на сайте
 *    обеспечивается сохранённой записью уведомления и НЕ зависит от результата
 *    доставки в MAX (Req 14.6, 15.7).
 * 2. **MAX.** Если запрошен канал {@link NotificationChannel.Max} и канал ещё
 *    не в окончательно-успешном статусе, выполняется доставка через
 *    {@link MaxDeliveryPort}. При успехе — `maxStatus = DELIVERED`. При неудаче
 *    решение о ретрае принимает чистая политика
 *    {@link decideMaxDeliveryOnFailure}: пока попытки не исчерпаны (≤3),
 *    `maxStatus = RETRY`, инкрементируется `maxRetryCount` и в очередь
 *    ставится отложенный ретрай (5 мин для Задач, 5 с для Сообщений, 30 с для
 *    аккаунта); по исчерпании попыток — `maxStatus = FAILED` без новой попытки
 *    (Req 13.13, 14.6, 15.7). Уведомление на сайте при этом сохраняется.
 *
 * Удаление уведомления о Сообщении в MAX (Req 14.7) выполняется методом
 * {@link NotificationDeliveryService.deleteMessageNotificationInMax}: при
 * неудаче фиксируется признак для повторной попытки, тогда как удаление на
 * сайте выполняется вызывающим кодом независимо.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly queue: QueueService,
    private readonly site: SiteNotificationDispatcher,
    private readonly redis: RedisService,
    @Inject(MAX_DELIVERY_PORT) private readonly maxPort: MaxDeliveryPort,
    private readonly maxFilter: MaxDeliveryFilter,
  ) {}

  /**
   * Обрабатывает одно задание доставки уведомления по запрошенным каналам.
   *
   * @param data Данные задания доставки (идентификатор уведомления, получатель,
   *   каналы).
   */
  async deliver(data: NotificationDeliveryJobData): Promise<void> {
    const notification = await this.repository.findById(data.notificationId);
    if (notification === null) {
      this.logger.warn(
        `Задание доставки для уведомления «${data.notificationId}» пропущено: запись не найдена.`,
      );
      return;
    }

    const channels = data.channels ?? [];
    if (channels.includes(NotificationChannel.Site)) {
      await this.deliverToSite(notification);
    }
    if (channels.includes(NotificationChannel.Max)) {
      await this.deliverToMax(notification);
    }
  }

  /**
   * Доставляет уведомление на сайт и фиксирует `siteStatus = DELIVERED`
   * независимо от канала MAX (Req 14.6, 15.7).
   */
  private async deliverToSite(notification: Notification): Promise<void> {
    if (notification.siteStatus === DeliveryStatus.DELIVERED) {
      return;
    }
    // realtime-push best-effort; доступность на сайте обеспечивает запись в БД.
    this.site.pushToUser(notification.recipientId, this.buildSitePayload(notification));
    await this.repository.update(notification.id, { siteStatus: DeliveryStatus.DELIVERED });
  }

  /**
   * Доставляет уведомление через Бот MAX с политикой ретраев (Req 13.13, 14.6,
   * 15.7).
   */
  private async deliverToMax(notification: Notification): Promise<void> {
    // Окончательно-успешный/намеренно пропущенный канал повторно не доставляем.
    if (
      notification.maxStatus === DeliveryStatus.DELIVERED ||
      notification.maxStatus === DeliveryStatus.SKIPPED
    ) {
      return;
    }

    // Фильтр отписок/заглушения: при полной отписке (Req 16.5) или отписке от
    // Задачи / заглушении её Чата (Req 16.6, 16.9) доставка в MAX подавляется и
    // фиксируется как SKIPPED, тогда как Уведомление на сайте сохраняется
    // независимо (Req 16.13).
    if (await this.maxFilter.isSuppressed(notification)) {
      await this.repository.update(notification.id, { maxStatus: DeliveryStatus.SKIPPED });
      this.logger.debug(
        `Доставка уведомления «${notification.id}» в MAX подавлена отпиской/заглушением ` +
          `получателя (maxStatus=SKIPPED); на сайте уведомление сохраняется.`,
      );
      return;
    }

    const result = await this.maxPort.deliverNotification(notification);
    if (result.delivered) {
      await this.repository.update(notification.id, { maxStatus: DeliveryStatus.DELIVERED });
      return;
    }

    const decision = decideMaxDeliveryOnFailure(notification.type, notification.maxRetryCount);
    await this.repository.update(notification.id, {
      maxStatus: decision.status,
      maxRetryCount: decision.attemptsMade,
    });

    if (decision.shouldRetry && decision.retryDelayMs !== null) {
      const retryJob: NotificationDeliveryJobData = {
        notificationId: notification.id,
        recipientId: notification.recipientId,
        // Ретрай касается только канала MAX; сайт уже доставлен независимо.
        channels: [NotificationChannel.Max],
      };
      await this.queue.add(QueueName.MaxNotifications, NOTIFICATION_DELIVERY_JOB_NAME, retryJob, {
        ...NOTIFICATION_DELIVERY_JOB_OPTIONS,
        delay: decision.retryDelayMs,
      });
      this.logger.debug(
        `Доставка уведомления «${notification.id}» в MAX не удалась ` +
          `(попытка ${decision.attemptsMade}): запланирован ретрай через ` +
          `${decision.retryDelayMs} мс${result.reason !== undefined ? ` — ${result.reason}` : ''}.`,
      );
    } else {
      this.logger.warn(
        `Доставка уведомления «${notification.id}» в MAX окончательно не удалась ` +
          `после ${decision.attemptsMade} попыток (maxStatus=FAILED); ` +
          'уведомление сохранено на сайте.',
      );
    }
  }

  /**
   * Удаляет уведомление о Сообщении в Боте MAX (Req 14.7, 16.12).
   *
   * При неуспешном удалении фиксирует признак для повторной попытки удаления в
   * MAX (через Redis). Удаление уведомления на сайте выполняется вызывающим
   * кодом независимо от результата этой операции (Req 14.7).
   *
   * @param notification Запись уведомления о Сообщении.
   * @returns `true`, если удаление в MAX выполнено успешно; иначе `false`
   *   (признак повторной попытки зафиксирован).
   */
  async deleteMessageNotificationInMax(notification: Notification): Promise<boolean> {
    const result = await this.maxPort.deleteMessageNotification(notification);
    if (result.delivered) {
      return true;
    }
    await this.recordFailedMaxDeletion(notification.id);
    this.logger.warn(
      `Удаление уведомления «${notification.id}» в MAX не удалось` +
        `${result.reason !== undefined ? ` — ${result.reason}` : ''}: ` +
        'зафиксирован признак повторной попытки; на сайте уведомление удаляется независимо.',
    );
    return false;
  }

  /** Фиксирует признак неуспешного удаления уведомления в MAX (Req 14.7). */
  private async recordFailedMaxDeletion(notificationId: string): Promise<void> {
    await this.redis.set(
      buildMaxDeletionRetryKey(notificationId),
      '1',
      NOTIFICATION_MAX_DELETION_RETRY_TTL_SECONDS,
    );
  }

  /**
   * Формирует полезную нагрузку realtime-уведомления на сайт.
   *
   * Живая сокет-нагрузка строится через {@link toNotificationView}, поэтому она
   * соответствует контракту `AppNotification` и совпадает с представлением
   * записи в Центре уведомлений (REST): фронтенд-`type`, локализованные
   * `title`/`body`, `siteStatus`/`maxStatus` и `createdAt` в ISO-8601 (Req 2.3).
   * Сырой доменный `payload` и внутренние поля наружу не отдаются. Форма
   * нагрузки не влияет на сохранение записи в БД и независимость доставки от MAX
   * (Req 3.3, 3.4).
   */
  private buildSitePayload(notification: Notification): NotificationView {
    return toNotificationView(notification);
  }
}
