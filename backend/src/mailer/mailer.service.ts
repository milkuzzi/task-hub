import { Injectable, Logger } from '@nestjs/common';
import { QueueName, QueueService } from '../infra';
import { EMAIL_JOB_NAME, EMAIL_JOB_OPTIONS } from './mailer.constants';
import { EmailMessage } from './mailer.types';

/**
 * Сервис исходящей почты (Req 1.6, 1.7).
 *
 * Не отправляет письма синхронно: вместо этого ставит их в очередь BullMQ
 * `email`, где фоновый воркер ({@link EmailWorker}) выполняет фактическую
 * отправку через адаптер SendPulse с числом попыток не более 3 и
 * экспоненциальным backoff. При окончательной неудаче доставки сервис
 * фиксирует факт неуспешной отправки, при этом письмо остаётся сохранённым в
 * очереди для последующей переотправки.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(private readonly queue: QueueService) {}

  /**
   * Ставит письмо в очередь отправки с политикой ретраев (≤3 попытки,
   * экспоненциальный backoff). Фактическая отправка выполняется воркером
   * асинхронно (Req 1.6, 1.7).
   */
  async enqueue(message: EmailMessage): Promise<void> {
    await this.queue.add(QueueName.Email, EMAIL_JOB_NAME, message, EMAIL_JOB_OPTIONS);
    this.logger.log(`Письмо для «${message.to}» поставлено в очередь отправки`);
  }

  /**
   * Фиксирует факт окончательно неуспешной доставки письма после исчерпания
   * всех попыток. Письмо при этом остаётся в очереди (removeOnFail: false) и
   * доступно для последующей переотправки (Req 1.7).
   */
  recordFailedDelivery(message: EmailMessage, attemptsMade: number, reason: string): void {
    this.logger.error(
      `Не удалось доставить письмо для «${message.to}» после ${attemptsMade} ` +
        `попыток: ${reason}. Сообщение сохранено в очереди для последующей отправки.`,
    );
  }
}
