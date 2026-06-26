import { Provider } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { AppConfigService } from '../../config';

/** DI-токен общего подключения ioredis. */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Строит параметры подключения ioredis из конфигурации приложения.
 * `maxRetriesPerRequest: null` требуется для совместимости с BullMQ и для
 * устойчивого переподключения. Пароль добавляется только при наличии
 * (учитывается `exactOptionalPropertyTypes`).
 */
export function buildRedisOptions(config: AppConfigService): RedisOptions {
  const { host, port, db, password } = config.redis;
  return {
    host,
    port,
    db,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * Провайдер общего подключения Redis.
 * Один разделяемый клиент используется {@link RedisService} и реестром сессий;
 * BullMQ создаёт собственные подключения из тех же параметров.
 */
export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): Redis => new Redis(buildRedisOptions(config)),
};
