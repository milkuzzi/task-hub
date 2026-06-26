import fc from 'fast-check';
import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { SessionRegistry } from '../infra';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { SessionAuthGuard, AuthenticatedRequest } from './session-auth.guard';
import { NoopSessionDisconnector } from './session-disconnector';
import { MaxOAuthPort } from '../max/oauth';

/**
 * **Feature: task-assignment-system, Property 9: Аннулирование сессий делает токены невалидными**
 *
 * Property 9 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 3.4, 8.6, 8.7, 19.10**:
 *
 * Для любого набора активных сессий пользователя после аннулирования (при
 * удалении пользователя или передаче роли администратора) все его
 * сессии/токены становятся невалидными, и последующие запросы с ними
 * отклоняются.
 *
 * Тест реализует ровно это одно свойство. Используется реальный путь выпуска и
 * проверки токенов: настоящий {@link JwtService} (HS256), настоящий
 * {@link SessionTokenService} и настоящий {@link SessionRegistry} поверх
 * in-memory подмены ioredis ({@link FakeRedis}) — обращений к живому Redis нет.
 * Аннулирование выполняется через прикладной сценарий
 * {@link AuthService.revokeAllSessions} (вызываемый при удалении пользователя
 * Req 8.6 и при передаче роли администратора Req 3.4). Последующие запросы
 * проверяются как напрямую через {@link SessionTokenService.verify}, так и
 * через HTTP-{@link SessionAuthGuard} (Req 8.7, 19.10). Минимум 100 итераций
 * на fast-check (здесь — 150).
 */
describe('Property 9: Аннулирование сессий делает токены невалидными (Req 3.4, 8.6, 8.7, 19.10)', () => {
  const SECRET = 'test-jwt-secret-for-property-9';
  const TTL_SECONDS = 900;

  /**
   * Минимальная in-memory реализация ioredis, покрывающая операции, которые
   * использует {@link SessionRegistry}: строковые ключи с/без TTL, множества и
   * конвейер `multi()`. Позволяет прогонять реальную логику реестра без живого
   * Redis.
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

  /** Собирает реальное окружение поверх FakeRedis (без живого Redis). */
  const makeEnv = () => {
    const fake = new FakeRedis();
    const sessions = new SessionRegistry(fake as unknown as Redis);
    const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: TTL_SECONDS } });
    const clock = { now: () => new Date() } as unknown as ClockService;
    const config = {
      auth: { jwtSecret: SECRET, accessTokenTtlSeconds: TTL_SECONDS },
    } as unknown as AppConfigService;

    const sessionTokens = new SessionTokenService(jwt, sessions, clock, config);
    const guard = new SessionAuthGuard(sessionTokens);

    const authService = new AuthService(
      {} as unknown as UserRepository,
      {} as unknown as PasswordService,
      {} as unknown as PasswordSetupTokenService,
      {} as unknown as MailerService,
      config,
      sessionTokens,
      clock,
      sessions,
      new NoopSessionDisconnector(),
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );

    return { sessions, sessionTokens, guard, authService };
  };

  /** Имитация HTTP-запроса с заголовком Authorization для guard-а. */
  const contextWithToken = (token: string): ExecutionContext => {
    const request = { headers: { authorization: `Bearer ${token}` } } as AuthenticatedRequest;
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  // Причина аннулирования: удаление пользователя (Req 8.6) либо передача роли
  // администратора (Req 3.4). Оба сценария ведут к revokeAllSessions.
  type RevocationCause = 'user-deletion' | 'admin-transfer';

  /**
   * Генератор: набор пользователей, у каждого — несколько активных сессий,
   * выбранная для аннулирования цель и причина аннулирования.
   */
  const scenarioArb = fc
    .record({
      sessionCounts: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 4 }),
      targetSelector: fc.nat(),
      cause: fc.constantFrom<RevocationCause>('user-deletion', 'admin-transfer'),
    })
    .map(({ sessionCounts, targetSelector, cause }) => {
      const users = sessionCounts.map((count, index) => ({
        userId: `user-${index}`,
        role: index === 0 ? Role.ADMIN : Role.EXECUTOR,
        sessionCount: count,
      }));
      return { users, targetIndex: targetSelector % users.length, cause };
    });

  it('после аннулирования все токены пользователя невалидны, чужие — не затронуты', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ users, targetIndex, cause }) => {
        void cause; // Обе причины аннулирования ведут к одному сценарию revokeAllSessions.
        const env = makeEnv();

        // Выпускаем реальные токены и регистрируем сессии для каждого пользователя.
        const tokensByUser = new Map<string, string[]>();
        for (const user of users) {
          const tokens: string[] = [];
          for (let i = 0; i < user.sessionCount; i += 1) {
            const issued = await env.sessionTokens.issue({
              id: user.userId,
              role: user.role,
            } as Pick<User, 'id' | 'role'>);
            tokens.push(issued.accessToken);
          }
          tokensByUser.set(user.userId, tokens);
        }

        // Предусловие: до аннулирования каждый токен проходит проверку.
        for (const user of users) {
          for (const token of tokensByUser.get(user.userId) as string[]) {
            const principal = await env.sessionTokens.verify(token);
            expect(principal.userId).toBe(user.userId);
          }
        }

        const target = users[targetIndex] as (typeof users)[number];
        const expectedRevoked = target.sessionCount;

        // Аннулирование при удалении пользователя / передаче роли администратора.
        const revoked = await env.authService.revokeAllSessions(target.userId);
        expect(revoked).toBe(expectedRevoked);

        // Все токены/сессии целевого пользователя стали невалидными, и любой
        // последующий запрос с ними отклоняется (Req 8.7, 19.10) — как через
        // прямую проверку токена, так и через HTTP-guard.
        for (const token of tokensByUser.get(target.userId) as string[]) {
          await expect(env.sessionTokens.verify(token)).rejects.toBeInstanceOf(
            AuthenticationException,
          );
          await expect(env.guard.canActivate(contextWithToken(token))).rejects.toBeInstanceOf(
            AuthenticationException,
          );
        }
        // Реестр сессий пользователя пуст.
        expect(await env.sessions.listUserTokens(target.userId)).toEqual([]);

        // Сессии остальных пользователей не затронуты (аннулирование скоупится).
        for (const user of users) {
          if (user.userId === target.userId) {
            continue;
          }
          for (const token of tokensByUser.get(user.userId) as string[]) {
            const principal = await env.sessionTokens.verify(token);
            expect(principal.userId).toBe(user.userId);
            await expect(env.guard.canActivate(contextWithToken(token))).resolves.toBe(true);
          }
        }

        // Повторное аннулирование идемпотентно: ничего не аннулирует.
        expect(await env.authService.revokeAllSessions(target.userId)).toBe(0);
      }),
      { numRuns: 150 },
    );
  });
});
