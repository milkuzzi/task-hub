import { Module } from '@nestjs/common';
import { RateLimiter } from './rate-limiter';
import { RateLimitGuard } from './rate-limit.guard';

/**
 * Модуль безопасности (Req 19).
 *
 * На текущем этапе предоставляет ограничение частоты запросов чувствительных
 * операций: переиспользуемый сервис {@link RateLimiter} (скользящее окно поверх
 * Redis) и {@link RateLimitGuard} для точечного подключения к контроллерам
 * входа, установки/смены пароля и загрузки, а также прямое использование
 * `RateLimiter.check` в прикладных сервисах для не-HTTP путей (Req 19.1, 19.2).
 * Зависимости `RedisService`, `ClockService` и `AppConfigService`
 * предоставляются глобальными модулями.
 *
 * Интеграция (задача 17.1): операция отправки Сообщения (`send_message`)
 * ограничивается напрямую в {@link ChatService.sendMessage} (источник —
 * отправитель), что покрывает web и mini-app пути через единый ChatService. Операции с
 * HTTP-обработчиками (`login`, `set_password`, `change_password`, `upload`)
 * помечаются декоратором `@RateLimit(op)` и закрываются {@link RateLimitGuard};
 * фактическая навеска guard'а выполняется вместе с появлением соответствующих
 * контроллеров на этапе интеграции (задача 21.1).
 *
 * Блокировка после неудачных входов реализуется смежной задачей (3.6).
 */
@Module({
  providers: [RateLimiter, RateLimitGuard],
  exports: [RateLimiter, RateLimitGuard],
})
export class SecurityModule {}
