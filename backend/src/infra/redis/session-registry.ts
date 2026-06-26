import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Запись о серверной сессии, хранимая в Redis.
 * Соответствует доменной сущности `Session` (Prisma): идентификатор токена,
 * владелец и момент истечения. Реестр в Redis обеспечивает аннулирование
 * токенов ≤5с (Req 3.4, 8.6, 19.10).
 */
export interface SessionRecord {
  /** Уникальный идентификатор токена (jti). */
  tokenId: string;
  /** Идентификатор пользователя — владельца сессии. */
  userId: string;
  /** Момент истечения сессии (ISO-8601, UTC). */
  expiresAt: string;
  /** Момент создания сессии (ISO-8601, UTC). */
  createdAt: string;
}

/** Префикс ключа записи сессии по идентификатору токена. */
const TOKEN_KEY_PREFIX = 'session:token:';
/** Префикс ключа множества активных токенов пользователя. */
const USER_KEY_PREFIX = 'session:user:';

/**
 * Реестр серверных сессий поверх Redis.
 *
 * Каждой сессии соответствует ключ `session:token:{tokenId}` с TTL до момента
 * истечения, а пользователю — множество `session:user:{userId}` его активных
 * токенов. Это позволяет как проверять валидность отдельного токена при каждом
 * запросе/socket-подключении, так и мгновенно аннулировать все сессии
 * пользователя (Req 3.4, 8.6, 19.10).
 */
@Injectable()
export class SessionRegistry {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Ключ записи сессии по идентификатору токена. */
  private tokenKey(tokenId: string): string {
    return `${TOKEN_KEY_PREFIX}${tokenId}`;
  }

  /** Ключ множества активных токенов пользователя. */
  private userKey(userId: string): string {
    return `${USER_KEY_PREFIX}${userId}`;
  }

  /** Вычисляет TTL в секундах до момента истечения (минимум 1с). */
  private ttlSeconds(expiresAt: string): number {
    const ms = new Date(expiresAt).getTime() - Date.now();
    return Math.max(1, Math.ceil(ms / 1000));
  }

  /**
   * Регистрирует новую сессию: сохраняет запись с TTL и добавляет токен в
   * множество активных токенов пользователя.
   */
  async register(record: SessionRecord): Promise<void> {
    const ttl = this.ttlSeconds(record.expiresAt);
    await this.redis
      .multi()
      .set(this.tokenKey(record.tokenId), JSON.stringify(record), 'EX', ttl)
      .sadd(this.userKey(record.userId), record.tokenId)
      .expire(this.userKey(record.userId), ttl)
      .exec();
  }

  /** Возвращает запись сессии по токену либо `null`, если её нет/истекла. */
  async get(tokenId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.tokenKey(tokenId));
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as SessionRecord;
  }

  /** Проверяет, действительна ли сессия с данным токеном. */
  async isValid(tokenId: string): Promise<boolean> {
    return (await this.redis.exists(this.tokenKey(tokenId))) === 1;
  }

  /**
   * Аннулирует конкретную сессию: удаляет запись токена и исключает токен из
   * множества пользователя.
   */
  async revoke(tokenId: string): Promise<void> {
    const record = await this.get(tokenId);
    const pipeline = this.redis.multi().del(this.tokenKey(tokenId));
    if (record !== null) {
      pipeline.srem(this.userKey(record.userId), tokenId);
    }
    await pipeline.exec();
  }

  /**
   * Аннулирует все сессии пользователя за одну операцию.
   * Возвращает число аннулированных токенов. Применяется при смене роли,
   * блокировке и удалении пользователя (Req 3.4, 8.6, 19.10).
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const tokenIds = await this.redis.smembers(this.userKey(userId));
    const keys = tokenIds.map((id) => this.tokenKey(id));
    keys.push(this.userKey(userId));
    await this.redis.del(...keys);
    return tokenIds.length;
  }

  /** Возвращает идентификаторы всех активных токенов пользователя. */
  listUserTokens(userId: string): Promise<string[]> {
    return this.redis.smembers(this.userKey(userId));
  }
}
