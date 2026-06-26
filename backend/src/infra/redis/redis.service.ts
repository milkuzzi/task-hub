import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Тонкая инъецируемая обёртка над общим подключением ioredis.
 *
 * Предоставляет базовые строковые/ключевые операции, используемые остальными
 * модулями (реестр сессий, rate-limit, счётчики попыток входа). Доступ к
 * «сырому» клиенту доступен через {@link RedisService.client} для специальных
 * случаев (множества, транзакции, pipeline). (Req 1.7, 13.12, 19.10)
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Низкоуровневый клиент ioredis для расширенных операций. */
  get client(): Redis {
    return this.redis;
  }

  /** Возвращает значение по ключу либо `null`, если ключ отсутствует. */
  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Сохраняет значение по ключу. При указании `ttlSeconds` ключ получает
   * срок жизни (EX).
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * Атомарно возвращает значение по ключу и удаляет ключ за одну операцию
   * (Redis `GETDEL`). Если ключ отсутствует — возвращает `null` и ничего не
   * удаляет. Применяется для одноразовых токенов: гарантирует, что значение
   * получит только один вызывающий, исключая повторное использование при гонке
   * (Req 5.6, 15.3, 19.6).
   */
  getDel(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }

  /** Удаляет один или несколько ключей, возвращает число удалённых. */
  del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return Promise.resolve(0);
    }
    return this.redis.del(...keys);
  }

  /** Проверяет существование ключа. */
  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  /** Устанавливает срок жизни ключа в секундах. */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  /** Возвращает оставшийся TTL ключа в секундах (-2 нет ключа, -1 без TTL). */
  ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  /** Атомарно инкрементирует числовое значение ключа. */
  incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  /**
   * Атомарно устанавливает значение ключа только при его отсутствии
   * (Redis `SET key value EX ttl NX`) и возвращает признак успешного захвата.
   *
   * Возвращает `true`, если ключ был создан этим вызовом, и `false`, если ключ
   * уже существовал (значение не перезаписывается). Применяется для разовых
   * маркеров-идемпотентности: гарантирует, что одно и то же событие будет
   * обработано ровно один раз даже при повторных/конкурентных вызовах
   * (Req 13.1, 13.12).
   */
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /** Закрывает общее подключение при остановке модуля. */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
