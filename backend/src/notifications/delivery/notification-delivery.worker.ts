import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../../config';
import { QueueName, buildRedisOptions } from '../../infra';
import { NotificationDeliveryJobData } from '../notifications.types';
import { NotificationDeliveryService } from './notification-delivery.service';

/**
 * Фоновый воркер доставки уведомлений по каналам (Req 13.13, 14.6, 15.7).
 *
 * Потребляет задания из очереди {@link QueueName.MaxNotifications} (имя задания
 * `deliver-notification`, ставится
 * {@link import('../notifications.service').NotificationsService.emit}) и
 * делегирует доставку {@link NotificationDeliveryService.deliver}. Доставка на
 * сайт и через Бот MAX, политика ретраев (≤3 попыток, интервалы 5 мин / 5 с /
 * 30 с) и фиксация итогового статуса по каждому каналу выполняются сервисом;
 * отложенные ретраи переотправляются в эту же очередь самим сервисом.
 *
 * Воркер запускается вместе с модулем уведомлений; ошибки доставки логируются,
 * а уведомление на сайте сохраняется независимо от результата MAX (Req 14.6,
 * 15.7).
 */
@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private worker: Worker<NotificationDeliveryJobData> | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  /** Запускает воркер очереди доставки уведомлений при инициализации модуля. */
  onModuleInit(): void {
    const connection = buildRedisOptions(this.config);
    this.worker = new Worker<NotificationDeliveryJobData>(
      QueueName.MaxNotifications,
      (job) => this.delivery.deliver(job.data),
      { connection },
    );

    this.worker.on('failed', (job, error) => {
      this.handleFailure(job, error);
    });

    this.logger.log('Воркер доставки уведомлений запущен');
  }

  /**
   * Логирует неуспешную обработку задания доставки. Политика ретраев доставки в
   * MAX реализуется сервисом через переотправку отложенных заданий; данное
   * событие фиксирует лишь непредвиденные сбои самого воркера.
   */
  private handleFailure(job: Job<NotificationDeliveryJobData> | undefined, error: Error): void {
    if (job === undefined) {
      this.logger.error(`Сбой обработки задания доставки без данных: ${error.message}`);
      return;
    }
    this.logger.error(
      `Сбой обработки задания доставки уведомления «${job.data.notificationId}»: ${error.message}`,
    );
  }

  /** Останавливает воркер при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    if (this.worker !== undefined) {
      await this.worker.close();
      this.worker = undefined;
    }
  }
}
