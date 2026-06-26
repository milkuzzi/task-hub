import fc from 'fast-check';
import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { SessionTokenService } from './session-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * **Feature: task-hub-bug-fixes, Property 17: Bug Condition — Поддержание активной Сессии**
 *
 * Exploratory-тест условия дефекта 9 (см. design.md «Дефект 9 — преждевременное
 * завершение Сессии», `isBugCondition_9`) — **Validates: Requirements 1.9, 2.9**.
 *
 * Назначение (методология bugfix): тест ДОЛЖЕН ПАДАТЬ на НЕИСПРАВЛЕННОМ коде —
 * падение подтверждает наличие дефекта. Дефект: в `AuthModule` отсутствует
 * механизм продления Сессии (нет `POST /auth/refresh` в {@link AuthController}
 * и метода `refreshSession` в {@link AuthService}). `SessionTokenService.issue`
 * выпускает короткоживущий токен (TTL = `accessTokenTtlSeconds`), `verify`
 * отклоняет истёкший токен, а эндпоинта обновления нет. Поэтому активная работа
 * дольше TTL приводит к 401 без возможности продления.
 *
 * Property 17 (ожидаемое корректное поведение): для любой активной работы
 * Пользователя, где `isBugCondition_9` истинно, исправленный код ДОЛЖЕН
 * поддерживать действующую Сессию через механизм продления (скользящая сессия /
 * обновление токена) без частого требования повторного входа. Минимальное и
 * устойчивое утверждение этого свойства на уровне кода — наличие самого
 * механизма продления (`AuthController.refresh` и `AuthService.refreshSession`).
 * На неисправленном коде таких методов нет → тест падает, фиксируя дефект.
 */
describe('Property 17: Поддержание активной Сессии (Дефект 9, Req 1.9, 2.9)', () => {
  const SECRET = 'test-jwt-secret-for-property-17';
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

  /** Управляемые часы: позволяют «прокрутить» активную работу за пределы TTL. */
  class MutableClock {
    constructor(private current: Date) {}
    now(): Date {
      return this.current;
    }
    advanceSeconds(seconds: number): void {
      this.current = new Date(this.current.getTime() + seconds * 1000);
    }
  }

  /** Реальное окружение выпуска/проверки токенов поверх FakeRedis. */
  const makeEnv = () => {
    const fake = new FakeRedis();
    const sessions = new SessionRegistry(fake as unknown as Redis);
    const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: TTL_SECONDS } });
    const clock = new MutableClock(new Date('2024-01-01T00:00:00.000Z'));
    const config = {
      auth: { jwtSecret: SECRET, accessTokenTtlSeconds: TTL_SECONDS },
    } as unknown as AppConfigService;
    const sessionTokens = new SessionTokenService(
      jwt,
      sessions,
      clock as unknown as ClockService,
      config,
    );
    return { sessions, sessionTokens, jwt, clock };
  };

  /**
   * Условие дефекта 9 над ВХОДНЫМ доменом: непрерывная активная работа дольше
   * TTL (`activeWorkSeconds > TTL_SECONDS`). Это предусловие описывает, что вход
   * принадлежит области проявления дефекта 9 — оно зависит ТОЛЬКО от входа.
   * Наличие/отсутствие механизма продления Сессии — это СИСТЕМНОЕ свойство,
   * проверяемое отдельными утверждениями ожидаемого поведения ниже
   * (`AuthController.refresh` и `AuthService.refreshSession`), а не часть
   * предусловия над входом (см. `isBugCondition_9` в design.md).
   */
  const isBugCondition_9 = (input: { activeWorkSeconds: number }): boolean => {
    return input.activeWorkSeconds > TTL_SECONDS;
  };

  /**
   * Генератор активной работы Пользователя, длящейся дольше TTL (TTL + 1с …
   * TTL + 1ч) — диапазон, в котором проявляется дефект 9.
   */
  const activeWorkArb = fc
    .integer({ min: 1, max: 3600 })
    .map((extraSeconds) => ({ activeWorkSeconds: TTL_SECONDS + extraSeconds }));

  it('Property 17: действующая Сессия поддерживается через продление без повторного входа', async () => {
    await fc.assert(
      fc.asyncProperty(activeWorkArb, async (input) => {
        const env = makeEnv();
        const user = { id: 'active-user', role: Role.EXECUTOR } as Pick<User, 'id' | 'role'>;

        // Пользователь входит и начинает активную работу.
        const session = await env.sessionTokens.issue(user);
        // Предусловие: сразу после входа Сессия действительна.
        await expect(env.sessionTokens.verify(session.accessToken)).resolves.toMatchObject({
          userId: user.id,
        });

        // Подтверждаем, что вход попал в условие дефекта 9: активная работа
        // длится дольше TTL и при этом механизм продления отсутствует.
        expect(isBugCondition_9(input)).toBe(true);

        // Property 17 (ожидаемое поведение): должен существовать механизм
        // продления Сессии, позволяющий активному Пользователю продолжать
        // работу без повторного входа. На неисправленном коде этих методов нет
        // — assert падает, подтверждая дефект 9.
        expect(
          typeof (AuthController.prototype as unknown as Record<string, unknown>).refresh,
        ).toBe('function');
        expect(
          typeof (AuthService.prototype as unknown as Record<string, unknown>).refreshSession,
        ).toBe('function');
      }),
      { numRuns: 100 },
    );
  });

  it('Следствие дефекта 9: по истечении TTL активный запрос получает 401 без возможности продления', async () => {
    // Документирует последствие отсутствия механизма продления: активный
    // Пользователь, проработавший дольше TTL, получает 401 и не может продлить
    // Сессию. Этот блок описывает наблюдаемое поведение дефекта (он не является
    // основным падающим утверждением — им является проверка наличия механизма
    // продления выше).
    const env = makeEnv();
    const user = { id: 'active-user', role: Role.EXECUTOR } as Pick<User, 'id' | 'role'>;

    // Истёкший access-токен (exp в прошлом) моделирует активную работу дольше
    // TTL без своевременного продления.
    const expiredToken = await env.jwt.signAsync(
      { sub: user.id, jti: 'expired-jti', role: user.role },
      { expiresIn: -1 },
    );

    // verify отклоняет истёкшую Сессию 401 — повторный вход неизбежен.
    await expect(env.sessionTokens.verify(expiredToken)).rejects.toBeInstanceOf(
      AuthenticationException,
    );

    // Механизма продления (для восстановления активной Сессии) не существует.
    const renewalMechanismExists =
      typeof (AuthController.prototype as unknown as Record<string, unknown>).refresh ===
        'function' &&
      typeof (AuthService.prototype as unknown as Record<string, unknown>).refreshSession ===
        'function';
    expect(renewalMechanismExists).toBe(true);
  });
});
