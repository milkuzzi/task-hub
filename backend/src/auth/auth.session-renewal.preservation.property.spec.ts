import fc from 'fast-check';
import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { SessionTokenService } from './session-token.service';

/**
 * **Feature: task-hub-bug-fixes, Property 18: Preservation — Отклонение аннулированных/истёкших Сессий**
 *
 * Preservation-тест дефекта 9 (см. design.md «Property 18: Preservation —
 * Отклонение аннулированных/истёкших Сессий») — **Validates: Requirements 3.9**.
 *
 * Назначение (методология bugfix, «сначала наблюдение»): тест фиксирует
 * поведение для входов ¬C (Сессии, не удовлетворяющие условию дефекта 9). Для
 * любой реально аннулированной (выход / принудительный сброс →
 * `SessionRegistry.revoke`, запись сессии удалена) либо истёкшей без продления
 * (JWT `exp` в прошлом) Сессии {@link SessionTokenService.verify} ДОЛЖЕН
 * отклонять запрос с {@link AuthenticationException} (401) и требовать
 * повторной аутентификации, а для действующей Сессии — разрешать доступ,
 * возвращая субъект.
 *
 * Будущее исправление дефекта 9 (task 27) добавляет `POST /auth/refresh` +
 * `AuthService.refreshSession` + проактивное продление на фронтенде, но НЕ
 * меняет поведение `verify`/guard. Поэтому этот тест ДОЛЖЕН ПРОХОДИТЬ как на
 * неисправленном, так и на исправленном коде (отсутствие регрессии).
 *
 * Используется реальный путь выпуска/проверки токенов: настоящий
 * {@link JwtService} (HS256), настоящий {@link SessionTokenService} и настоящий
 * {@link SessionRegistry} поверх in-memory подмены ioredis ({@link FakeRedis}) —
 * обращений к живому Redis нет. Минимум 100 итераций fast-check.
 */
describe('Property 18: Preservation — Отклонение аннулированных/истёкших Сессий (Req 3.9)', () => {
  const SECRET = 'test-jwt-secret-for-property-18';
  const TTL_SECONDS = 900; // accessTokenTtlSeconds по умолчанию (15 минут).

  /**
   * Минимальная in-memory реализация ioredis, покрывающая операции
   * {@link SessionRegistry}: строки с/без TTL, множества и конвейер `multi()`.
   */
  class FakeRedis {
    private strings = new Map<string, string>();
    private sets = new Map<string, Set<string>>();

    async get(key: string): Promise<string | null> {
      return this.strings.has(key) ? (this.strings.get(key) as string) : null;
    }

    async smembers(key: string): Promise<string[]> {
      return [...(this.sets.get(key) ?? new Set<string>())];
    }

    async exists(key: string): Promise<number> {
      return this.strings.has(key) ? 1 : 0;
    }

    async del(...keys: string[]): Promise<number> {
      return this.delSync(...keys);
    }

    delSync(...keys: string[]): number {
      let removed = 0;
      for (const key of keys) {
        if (this.strings.delete(key)) {
          removed += 1;
        }
        this.sets.delete(key);
      }
      return removed;
    }

    setSync(key: string, value: string): void {
      this.strings.set(key, value);
    }

    saddSync(key: string, member: string): void {
      const set = this.sets.get(key) ?? new Set<string>();
      set.add(member);
      this.sets.set(key, set);
    }

    sremSync(key: string, member: string): void {
      this.sets.get(key)?.delete(member);
    }

    multi(): FakePipeline {
      return new FakePipeline(this);
    }
  }

  /** Цепочечный конвейер, имитирующий ChainableCommander ioredis. */
  class FakePipeline {
    private readonly ops: Array<() => void> = [];

    constructor(private readonly store: FakeRedis) {}

    set(key: string, value: string): this {
      this.ops.push(() => this.store.setSync(key, value));
      return this;
    }

    sadd(key: string, member: string): this {
      this.ops.push(() => this.store.saddSync(key, member));
      return this;
    }

    srem(key: string, member: string): this {
      this.ops.push(() => this.store.sremSync(key, member));
      return this;
    }

    del(key: string): this {
      this.ops.push(() => {
        this.store.delSync(key);
      });
      return this;
    }

    expire(key: string, ttl: number): this {
      void key;
      void ttl;
      return this;
    }

    async exec(): Promise<void> {
      for (const op of this.ops) {
        op();
      }
    }
  }

  /** Реальное окружение выпуска/проверки токенов поверх FakeRedis. */
  const makeEnv = () => {
    const fake = new FakeRedis();
    const sessions = new SessionRegistry(fake as unknown as Redis);
    const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: TTL_SECONDS } });
    const clock = { now: () => new Date() } as unknown as ClockService;
    const config = {
      auth: { jwtSecret: SECRET, accessTokenTtlSeconds: TTL_SECONDS },
    } as unknown as AppConfigService;
    const sessionTokens = new SessionTokenService(jwt, sessions, clock, config);
    return { sessions, sessionTokens, jwt };
  };

  // Домены токенов (¬C для дефекта 9): действующая, аннулированная, истёкшая.
  type TokenDomain = 'valid' | 'revoked' | 'expired';

  /** Способ аннулирования действующей Сессии (оба ведут к revoke записи). */
  type RevokeCause = 'logout' | 'forced-reset';

  /**
   * Генератор сценария: домен токена, роль владельца, причина аннулирования и
   * идентификатор пользователя.
   */
  const scenarioArb = fc.record({
    domain: fc.constantFrom<TokenDomain>('valid', 'revoked', 'expired'),
    role: fc.constantFrom<Role>(Role.ADMIN, Role.MANAGER, Role.EXECUTOR),
    cause: fc.constantFrom<RevokeCause>('logout', 'forced-reset'),
    userSuffix: fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0),
  });

  it('Property 18: действующая Сессия проходит; аннулированная или истёкшая отклоняется 401', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ domain, role, cause, userSuffix }) => {
        const env = makeEnv();
        const user = { id: `user-${userSuffix}`, role } as Pick<User, 'id' | 'role'>;

        if (domain === 'valid') {
          // Действующая Сессия: verify возвращает субъект (доступ разрешён).
          const session = await env.sessionTokens.issue(user);
          await expect(env.sessionTokens.verify(session.accessToken)).resolves.toMatchObject({
            userId: user.id,
            tokenId: session.tokenId,
            role: user.role,
          });
          return;
        }

        if (domain === 'revoked') {
          // Реально аннулированная Сессия (выход / принудительный сброс):
          // запись токена удалена из реестра. До аннулирования токен валиден,
          // после — отклоняется 401 и требует повторной аутентификации.
          const session = await env.sessionTokens.issue(user);
          await expect(env.sessionTokens.verify(session.accessToken)).resolves.toMatchObject({
            userId: user.id,
          });

          // Обе причины (logout/принудительный сброс) аннулируют запись сессии.
          if (cause === 'logout') {
            await env.sessions.revoke(session.tokenId);
          } else {
            await env.sessions.revokeAllForUser(user.id);
          }

          await expect(env.sessionTokens.verify(session.accessToken)).rejects.toBeInstanceOf(
            AuthenticationException,
          );
          return;
        }

        // domain === 'expired': истёкший без продления токен (exp в прошлом).
        // Подпись валидна, но срок действия истёк — verify отклоняет 401.
        const expiredToken = await env.jwt.signAsync(
          { sub: user.id, jti: 'expired-jti', role: user.role },
          { expiresIn: -1 },
        );
        await expect(env.sessionTokens.verify(expiredToken)).rejects.toBeInstanceOf(
          AuthenticationException,
        );
      }),
      { numRuns: 100 },
    );
  });
});
