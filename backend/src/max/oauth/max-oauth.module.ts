import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../config';
import { MaxOAuthHttpClient } from './max-oauth.client';
import { MAX_OAUTH_PORT } from './max-oauth.port';

/**
 * Модуль входа через OAuth MAX (Req 5.11, 16.1, 16.2, 16.3).
 *
 * Предоставляет порт обмена кода авторизации {@link MAX_OAUTH_PORT} с
 * реализацией по умолчанию — HTTP-адаптером {@link MaxOAuthHttpClient}. Выделен
 * из {@link import('../max.module').MaxIntegrationModule} в отдельный модуль,
 * чтобы {@link import('../../auth').AuthModule} мог зависеть только от логики
 * OAuth, не вовлекая Бот MAX и его зависимости (Чат, Задачи, Вложения). Это
 * исключает циклическую зависимость модулей: Бот MAX
 * ({@link import('../max.module').MaxIntegrationModule}) импортирует `ChatModule`,
 * который, в свою очередь, импортирует `AuthModule`.
 *
 * В тестах к токену {@link MAX_OAUTH_PORT} привязывается мок, что исключает
 * сетевые вызовы и необходимость реальных учётных данных MAX.
 */
@Module({
  imports: [AppConfigModule],
  providers: [MaxOAuthHttpClient, { provide: MAX_OAUTH_PORT, useExisting: MaxOAuthHttpClient }],
  exports: [MAX_OAUTH_PORT],
})
export class MaxOAuthModule {}
