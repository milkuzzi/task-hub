import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfigService } from '../config';
import { RedisService } from '../infra';

/** Префикс ключа Redis для одноразового токена установки пароля. */
const TOKEN_KEY_PREFIX = 'auth:password-setup:';

/** Длина случайного секрета токена в байтах (256 бит энтропии). */
const TOKEN_BYTES = 32;

/**
 * Хранилище одноразовых токенов установки пароля (Req 5.3, 5.6, 15.2, 15.3,
 * 19.5–19.7).
 *
 * Токен — криптослучайный секрет, передаваемый пользователю в ссылке письма.
 * В Redis сохраняется только его SHA-256-хеш (как идентификатор ключа) с TTL,
 * равным сроку действия ссылки (по умолчанию 24 ч). Хранение хеша, а не самого
 * секрета, исключает компрометацию активных ссылок при доступе к хранилищу.
 *
 * Одноразовость и срок действия обеспечиваются средствами Redis:
 * - срок действия — через TTL ключа (просроченный токен исчезает сам);
 * - одноразовость — через атомарную операцию `GETDEL` при потреблении: значение
 *   получает ровно один вызывающий, повторное использование невозможно даже при
 *   гонке (Req 5.6, 15.3, 19.6).
 */
@Injectable()
export class PasswordSetupTokenService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
  ) {}

  /** Вычисляет ключ Redis по необратимому хешу секрета токена. */
  private keyFor(token: string): string {
    const hash = createHash('sha256').update(token).digest('hex');
    return `${TOKEN_KEY_PREFIX}${hash}`;
  }

  /**
   * Выпускает новый одноразовый токен для пользователя и сохраняет его с TTL,
   * равным {@link LimitsConfig.passwordSetupTtlSeconds} (Req 15.2, 19.5).
   *
   * @param userId Идентификатор приглашённого пользователя.
   * @returns Открытый секрет токена для вставки в ссылку письма (в Redis он
   *   хранится только в виде хеша).
   */
  async issue(userId: string): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const ttlSeconds = this.config.limits.passwordSetupTtlSeconds;
    await this.redis.set(this.keyFor(token), userId, ttlSeconds);
    return token;
  }

  /**
   * Потребляет токен: атомарно возвращает связанный идентификатор пользователя
   * и аннулирует токен (одноразовость, Req 5.6, 15.3, 19.6).
   *
   * @param token Открытый секрет токена из ссылки.
   * @returns Идентификатор пользователя, либо `null`, если токен недействителен
   *   (не существует, просрочен или уже использован — Req 19.7).
   */
  consume(token: string): Promise<string | null> {
    return this.redis.getDel(this.keyFor(token));
  }
}
