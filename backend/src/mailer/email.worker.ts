import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { AppConfigService } from '../config';
import { QueueName, buildRedisOptions } from '../infra';
import { MAILER_PROVIDER, MAX_EMAIL_ATTEMPTS, hasExhaustedAttempts } from './mailer.constants';
import { MailerService } from './mailer.service';
import { EmailMessage, MailerProvider } from './mailer.types';

/**
 * Фоновый воркер очереди email (Req 1.6, 1.7).
 *
 * Потребляет задания из очереди `email` и отправляет письмо через адаптер
 * SendPulse ({@link MailerProvider}). BullMQ автоматически повторяет неуспешные
 * задания согласно параметрам задания (не более 3 попыток с экспоненциальным
 * backoff). После исчерпания всех попыток воркер фиксирует факт неуспешной
 * доставки через {@link MailerService.recordFailedDelivery}; само задание
 * остаётся в очереди для последующей переотправки.
 */
@Injectable()
export class EmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailWorker.name);
  private worker: Worker<EmailMessage> | undefined;

  constructor(
    private readonly config: AppConfigService,
    private readonly mailer: MailerService,
    @Inject(MAILER_PROVIDER) private readonly provider: MailerProvider,
  ) {}

  /** Запускает воркер очереди email при инициализации модуля. */
  onModuleInit(): void {
    const connection = buildRedisOptions(this.config);
    this.worker = new Worker<EmailMessage>(QueueName.Email, (job) => this.provider.send(job.data), {
      connection,
    });

    this.worker.on('failed', (job, error) => {
      this.handleFailure(job, error);
    });

    this.logger.log('Воркер очереди email запущен');
  }

  /**
   * Обрабатывает событие неуспешной попытки. При исчерпании допустимого числа
   * попыток фиксирует окончательную неудачу доставки; иначе логирует промежу-
   * точную неудачу — BullMQ выполнит следующую попытку.
   */
  private handleFailure(job: Job<EmailMessage> | undefined, error: Error): void {
    if (job === undefined) {
      this.logger.error(`Неуспешная отправка письма без данных задания: ${error.message}`);
      return;
    }

    const maxAttempts = job.opts.attempts ?? MAX_EMAIL_ATTEMPTS;
    if (hasExhaustedAttempts(job.attemptsMade, maxAttempts)) {
      this.mailer.recordFailedDelivery(job.data, job.attemptsMade, error.message);
    } else {
      this.logger.warn(
        `Попытка ${job.attemptsMade} из ${maxAttempts} отправки письма для ` +
          `«${job.data.to}» не удалась: ${error.message}. Будет выполнена повторная попытка.`,
      );
    }
  }

  /** Останавливает воркер при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    if (this.worker !== undefined) {
      await this.worker.close();
      this.worker = undefined;
    }
  }
}
