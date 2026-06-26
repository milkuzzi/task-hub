import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments';
import { ChatModule } from '../chat';
import { TasksModule } from '../tasks';
import { MaxOAuthModule } from './oauth';
import {
  MAX_BOT_API_PORT,
  MaxBotService,
  MaxBotWebhookController,
  MaxBotWebhookGuard,
  UnavailableMaxBotApiAdapter,
} from './bot';

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
 * - **Бот MAX** (Req 16.4–16.13) — {@link MaxBotService} (идентификация
 *   Пользователя по профилю MAX и делегирование существующим сервисам Задач,
 *   Чата и Вложений) и {@link MaxBotWebhookController} (приём входящих обновлений
 *   и маршрутизация в сервис, Req 16.4). Исходящее взаимодействие с Bot API MAX
 *   абстрагировано портом {@link MAX_BOT_API_PORT} (по умолчанию — безопасная
 *   заглушка {@link UnavailableMaxBotApiAdapter} до подключения реальной
 *   интеграции).
 *
 * Фильтрация доставки Уведомлений через Бот MAX по отпискам/заглушению
 * (Req 16.5, 16.6, 16.9, 16.13) реализована в `NotificationsModule`
 * (`MaxDeliveryFilter`) на пути доставки в MAX; команды Бота лишь изменяют
 * состояние отписок (`MaxLink.mutedAll`) и заглушения (`ChatMute`).
 *
 * Зависимости Бота ({@link TasksModule}, {@link ChatModule},
 * {@link AttachmentsModule}) предоставляют прикладные сервисы; репозитории и
 * конфигурация доступны через глобальные модули.
 */
@Module({
  imports: [MaxOAuthModule, TasksModule, ChatModule, AttachmentsModule],
  controllers: [MaxBotWebhookController],
  providers: [
    MaxBotService,
    MaxBotWebhookGuard,
    UnavailableMaxBotApiAdapter,
    { provide: MAX_BOT_API_PORT, useExisting: UnavailableMaxBotApiAdapter },
  ],
  exports: [MaxOAuthModule, MaxBotService],
})
export class MaxIntegrationModule {}
