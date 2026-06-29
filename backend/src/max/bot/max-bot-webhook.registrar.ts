import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MaxBotHttpApiAdapter } from './max-bot-http.adapter';

/** Регистрирует webhook-подписку MAX после старта приложения. */
@Injectable()
export class MaxBotWebhookRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaxBotWebhookRegistrar.name);

  constructor(private readonly api: MaxBotHttpApiAdapter) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.api.ensureWebhookSubscription();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Не удалось зарегистрировать webhook Бота MAX: ${reason}.`);
    }
  }
}
