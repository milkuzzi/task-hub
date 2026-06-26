import { Injectable, Logger } from '@nestjs/common';
import { Notification } from '@prisma/client';
import { EntityNotFoundException } from '../common/errors';
import { QueueName, QueueService, RedisService } from '../infra';
import {
  NOTIFICATION_DELIVERY_JOB_NAME,
  NOTIFICATION_DELIVERY_JOB_OPTIONS,
  NOTIFICATION_IDEMPOTENCY_TTL_SECONDS,
  buildIdempotencyKey,
} from './notifications.constants';
import { NotificationRepository } from './notification.repository';
import {
  DEFAULT_NOTIFICATION_CHANNELS,
  DomainEvent,
  NotificationChannel,
  NotificationDeliveryJobData,
} from './notifications.types';

/**
 * Сервис формирования уведомлений по доменным событиям (Req 13.1, 13.12).
 *
 * Метод {@link emit} порождает по ОДНОМУ отдельному уведомлению на каждого
 * получателя события (без объединения событий в дайджест, Req 13.1) и ставит
 * задание доставки в очередь BullMQ. Метод возвращает управление сразу после
 * постановки заданий в очередь, что удовлетворяет требованию формирования и
 * постановки уведомления в течение 60 секунд с момента события (Req 13.12) —
 * фактическая доставка по каналам и ретраи выполняются воркером (задача 12.10).
 *
 * Идемпотентность обеспечивается маркером в Redis на пару «ключ события +
 * получатель»: перед созданием записи маркер захватывается атомарно
 * (`SET … NX`); если он уже существует, уведомление этому получателю не
 * создаётся повторно (Req 13.1). При сбое создания/постановки в очередь маркер
 * освобождается, чтобы повторный вызов смог корректно сформировать уведомление.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly queue: QueueService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Формирует уведомления по доменному событию и ставит их доставку в очередь
   * (Req 13.1, 13.12).
   *
   * Для каждого уникального получателя создаётся отдельная запись уведомления
   * со статусами доставки `PENDING` и помещается задание доставки в очередь.
   * Повторные получатели и повторные вызовы с тем же {@link DomainEvent.eventKey}
   * не порождают дубликатов.
   *
   * @param event Доменное событие с получателями, полезной нагрузкой и ключом
   *   идемпотентности.
   */
  async emit(event: DomainEvent): Promise<void> {
    const channels: NotificationChannel[] = [...(event.channels ?? DEFAULT_NOTIFICATION_CHANNELS)];
    const uniqueRecipientIds = [...new Set(event.recipientIds)];

    for (const recipientId of uniqueRecipientIds) {
      const claimed = await this.claimIdempotency(event.eventKey, recipientId);
      if (!claimed) {
        this.logger.debug(
          `Уведомление для получателя «${recipientId}» по событию «${event.eventKey}» ` +
            `уже сформировано — пропуск (идемпотентность, Req 13.1).`,
        );
        continue;
      }

      try {
        const notification = await this.repository.create({
          recipientId,
          taskId: event.taskId ?? null,
          messageId: event.messageId ?? null,
          type: event.type,
          payload: event.payload,
          isMessageNotification: event.isMessageNotification ?? false,
        });

        const jobData: NotificationDeliveryJobData = {
          notificationId: notification.id,
          recipientId,
          channels,
        };
        await this.queue.add(
          QueueName.MaxNotifications,
          NOTIFICATION_DELIVERY_JOB_NAME,
          jobData,
          NOTIFICATION_DELIVERY_JOB_OPTIONS,
        );
      } catch (error) {
        // Освобождаем маркер, чтобы повторный вызов смог сформировать
        // уведомление: иначе сбой создания/постановки навсегда заблокировал бы
        // получателя (Req 13.1).
        await this.releaseIdempotency(event.eventKey, recipientId);
        throw error;
      }
    }
  }

  /**
   * Атомарно захватывает маркер-идемпотентности для пары «событие +
   * получатель». Возвращает `true`, если маркер захвачен этим вызовом, и
   * `false`, если уведомление этому получателю уже формировалось (Req 13.1).
   */
  private claimIdempotency(eventKey: string, recipientId: string): Promise<boolean> {
    return this.redis.setNx(
      buildIdempotencyKey(eventKey, recipientId),
      '1',
      NOTIFICATION_IDEMPOTENCY_TTL_SECONDS,
    );
  }

  /** Освобождает маркер-идемпотентности при сбое формирования уведомления. */
  private async releaseIdempotency(eventKey: string, recipientId: string): Promise<void> {
    await this.redis.del(buildIdempotencyKey(eventKey, recipientId));
  }

  /**
   * Возвращает Уведомления текущего Пользователя в порядке от новых к старым
   * (Req 7.1, 7.4, 13.1).
   *
   * Выборка строго ограничена получателем `recipientId`, поэтому Пользователь
   * получает только собственные Уведомления и не может увидеть чужие (Req 2.12,
   * 7.4). Порядок «новые → старые» обеспечивает репозиторий.
   *
   * @param recipientId Идентификатор текущего Пользователя (владельца).
   * @returns Список Уведомлений Пользователя (новые → старые).
   */
  listForRecipient(recipientId: string): Promise<Notification[]> {
    return this.repository.listByRecipient(recipientId);
  }

  /**
   * Скрывает (удаляет) Уведомление текущего Пользователя по идентификатору
   * (Req 7.3, 7.4).
   *
   * Удаление выполняется только для Уведомления, принадлежащего `recipientId`.
   * Если Уведомления с таким идентификатором у Пользователя нет (отсутствует
   * или принадлежит другому), выбрасывается {@link EntityNotFoundException} —
   * существование чужих Уведомлений не раскрывается (Req 2.12, 7.4).
   *
   * @param recipientId Идентификатор текущего Пользователя (владельца).
   * @param notificationId Идентификатор скрываемого Уведомления.
   */
  async dismiss(recipientId: string, notificationId: string): Promise<void> {
    const deleted = await this.repository.deleteByIdForRecipient(notificationId, recipientId);
    if (deleted === 0) {
      throw new EntityNotFoundException('Уведомление не найдено.');
    }
  }
}
