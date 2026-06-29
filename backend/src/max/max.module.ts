import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { SecurityModule } from '../security';
import { MaxOAuthModule } from './oauth';
import { MAX_BOT_API_PORT } from './bot/max-bot-api.port';
import { MaxBotHttpApiAdapter } from './bot/max-bot-http.adapter';
import { MaxBotAuthController } from './bot/max-bot-auth.controller';
import { MaxBotAuthService } from './bot/max-bot-auth.service';
import { MaxBotUpdateController } from './bot/max-bot.update.controller';
import { MaxBotWebhookRegistrar } from './bot/max-bot-webhook.registrar';
import { MaxBotWebhookGuard } from './bot/max-bot-webhook.guard';
import { MaxMiniAppAuthController, MaxMiniAppAuthService } from './mini-app';

/**
 * Модуль интеграции с платформой MAX (Req 16).
 *
 * Объединяет две части интеграции:
 *
 * - **Вход через OAuth MAX** (Req 5.11, 16.1–16.3) — реэкспортируется из
 *   {@link MaxOAuthModule}, который предоставляет порт обмена кода авторизации
 *   `MAX_OAUTH_PORT`. {@link import('../auth').AuthModule} зависит напрямую от
 *   {@link MaxOAuthModule}, поэтому вход через MAX не вовлекает Бот MAX и его
 *   зависимости (Чат/Задачи/Вложения).
 * - **Mini-app и Бот MAX** — подписанные данные запуска обмениваются на обычную
 *   Сессию Системы, а Бот оставляет только подтверждение привязки, доставку
 *   Уведомлений и кнопку запуска mini-app. Исходящее взаимодействие с Bot API
 *   абстрагировано портом {@link MAX_BOT_API_PORT}.
 *
 * Фильтрация доставки Уведомлений через Бот MAX по отпискам/заглушению
 * (Req 16.5, 16.6, 16.9, 16.13) реализована в `NotificationsModule`
 * (`MaxDeliveryFilter`) на пути доставки в MAX; настройки меняются через
 * авторизованные API профиля и Задачи.
 */
@Module({
  imports: [MaxOAuthModule, AuthModule, SecurityModule],
  controllers: [MaxBotUpdateController, MaxBotAuthController, MaxMiniAppAuthController],
  providers: [
    MaxBotAuthService,
    MaxBotWebhookGuard,
    MaxBotHttpApiAdapter,
    MaxBotWebhookRegistrar,
    MaxMiniAppAuthService,
    { provide: MAX_BOT_API_PORT, useExisting: MaxBotHttpApiAdapter },
  ],
  exports: [MaxOAuthModule, MaxBotAuthService],
})
export class MaxIntegrationModule {}
