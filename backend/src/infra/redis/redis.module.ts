import { Global, Module } from '@nestjs/common';
import { redisClientProvider, REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';
import { SessionRegistry } from './session-registry';

/**
 * Глобальный модуль Redis.
 * Создаёт общее подключение ioredis и экспортирует {@link RedisService}
 * (базовые операции) и {@link SessionRegistry} (реестр сессий для
 * аннулирования токенов ≤5с).
 */
@Global()
@Module({
  providers: [redisClientProvider, RedisService, SessionRegistry],
  exports: [REDIS_CLIENT, RedisService, SessionRegistry],
})
export class RedisModule {}
