import { Global, Module } from '@nestjs/common';
import { EmailWorker } from './email.worker';
import { MAILER_PROVIDER } from './mailer.constants';
import { MailerService } from './mailer.service';
import { SendPulseClient } from './sendpulse.client';

/**
 * Глобальный модуль исходящей почты (Req 1.6, 1.7).
 *
 * Предоставляет {@link MailerService} (постановка писем в очередь с ретраями)
 * и регистрирует адаптер SendPulse как реализацию {@link MAILER_PROVIDER}.
 * Воркер очереди email ({@link EmailWorker}) запускается вместе с модулем и
 * выполняет фактическую отправку. Адаптер скрыт за DI-токеном, что позволяет
 * подменять его в тестах без реальных учётных данных.
 */
@Global()
@Module({
  providers: [
    MailerService,
    EmailWorker,
    SendPulseClient,
    { provide: MAILER_PROVIDER, useExisting: SendPulseClient },
  ],
  exports: [MailerService],
})
export class MailerModule {}
