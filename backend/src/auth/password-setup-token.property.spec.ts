import fc from 'fast-check';
import { UnprocessableException } from '../common/errors';
import { AppConfigService } from '../config';
import { RedisService } from '../infra';
import { SessionRegistry } from '../infra';
import { SessionDisconnector } from './session-disconnector';
import { MaxOAuthPort } from '../max/oauth';
import { MailerService } from '../mailer';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { ClockService } from '../clock';

/**
 * **Feature: task-assignment-system, Property 12: Жизненный цикл одноразовой
 * ссылки установки пароля**
 *
 * *Для любой* ссылки установки пароля: она валидна тогда и только тогда, когда
 * текущий момент не превышает момент выпуска плюс 24 часа (86400 с) и она ещё
 * не была использована; после успешного использования ИЛИ истечения срока
 * повторная установка пароля отклоняется.
 *
 * **Validates: Requirements 5.6, 15.2, 15.3, 19.5, 19.6, 19.7**
 *
 * Подход: реальные {@link PasswordSetupTokenService} и {@link AuthService}
 * поверх in-memory подмены Redis с семантикой TTL + одноразового GETDEL,
 * управляемой инъецированными «часами». Время выпуска и потребления токена
 * задаётся детерминированно — без живого Redis и без таймеров.
 */
describe('Property 12: Жизненный цикл одноразовой ссылки установки пароля', () => {
  /** Срок действия ссылки по умолчанию — 24 ч = 86400 с (Req 15.2, 19.5). */
  const TTL_SECONDS = 86400;
  /** Корректный по длине пароль (8–128 символов) — валидация длины не в фокусе. */
  const VALID_PASSWORD = 'valid-password-123';

  /** Управляемый источник «сейчас»: тесты двигают время явно. */
  class FakeClock {
    private currentMs = 0;
    now(): number {
      return this.currentMs;
    }
    setMs(ms: number): void {
      this.currentMs = ms;
    }
  }

  /**
   * In-memory подмена {@link RedisService} с TTL и атомарным GETDEL.
   *
   * Запись хранит момент истечения `expiresAtMs = setMs + ttl*1000`. Ключ
   * считается просроченным, когда текущее время строго больше момента
   * истечения, что соответствует определению свойства «валидна, пока
   * now ≤ issue + TTL». GETDEL возвращает значение не более одного раза —
   * это обеспечивает одноразовость (Req 5.6, 15.3, 19.6).
   */
  class FakeRedis {
    private store = new Map<string, { value: string; expiresAtMs: number | null }>();
    constructor(private readonly clock: FakeClock) {}

    private isExpired(entry: { expiresAtMs: number | null }): boolean {
      return entry.expiresAtMs !== null && this.clock.now() > entry.expiresAtMs;
    }

    set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      const expiresAtMs = ttlSeconds === undefined ? null : this.clock.now() + ttlSeconds * 1000;
      this.store.set(key, { value, expiresAtMs });
      return Promise.resolve();
    }

    getDel(key: string): Promise<string | null> {
      const entry = this.store.get(key);
      if (entry === undefined) {
        return Promise.resolve(null);
      }
      // Просроченный ключ ведёт себя как отсутствующий и удаляется (Req 19.7).
      if (this.isExpired(entry)) {
        this.store.delete(key);
        return Promise.resolve(null);
      }
      // Одноразовость: значение выдаётся ровно один раз, затем ключ удаляется.
      this.store.delete(key);
      return Promise.resolve(entry.value);
    }
  }

  type Harness = {
    clock: FakeClock;
    auth: AuthService;
    tokens: PasswordSetupTokenService;
    activations: string[];
  };

  /** Собирает свежую связку сервисов и фейков с чистым состоянием. */
  function buildHarness(): Harness {
    const clock = new FakeClock();
    const redis = new FakeRedis(clock) as unknown as RedisService;
    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      limits: {
        passwordSetupTtlSeconds: TTL_SECONDS,
        passwordMinLength: 8,
        passwordMaxLength: 128,
      },
    } as unknown as AppConfigService;

    const tokens = new PasswordSetupTokenService(redis, config);

    const activations: string[] = [];
    const user = { id: 'user-1', email: 'u@example.com', deletedAt: null };
    const userRepository = {
      findById: jest.fn().mockResolvedValue(user),
      update: jest.fn(async (id: string) => {
        activations.push(id);
      }),
    } as unknown as UserRepository;
    const passwords = {
      hash: jest.fn().mockResolvedValue('hashed'),
    } as unknown as PasswordService;
    const mailer = { enqueue: jest.fn() } as unknown as MailerService;

    const auth = new AuthService(
      userRepository,
      passwords,
      tokens,
      mailer,
      config,
      { issue: jest.fn() } as unknown as SessionTokenService,
      { now: jest.fn(() => new Date()) } as unknown as ClockService,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );
    return { clock, auth, tokens, activations };
  }

  /** Пытается установить пароль; возвращает true при успехе, false при отказе. */
  async function trySetPassword(auth: AuthService, token: string): Promise<boolean> {
    try {
      await auth.setPassword(token, VALID_PASSWORD);
      return true;
    } catch (error) {
      // Недействительная/просроченная/использованная ссылка отклоняется
      // именно как UnprocessableException (Req 5.6, 19.6, 19.7).
      expect(error).toBeInstanceOf(UnprocessableException);
      return false;
    }
  }

  it('ссылка валидна ⇔ (now ≤ issue + 86400с) ∧ не использована; иначе отклоняется', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Абсолютный момент выпуска (варьируем, чтобы не зависеть от нуля).
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        // Прошедшее с выпуска время в секундах: покрывает обе стороны TTL.
        fc.integer({ min: 0, max: 200_000 }),
        // Использовать ли ссылку успешно ещё до измеряемой попытки.
        fc.boolean(),
        async (issueMs, elapsedSeconds, useFirst) => {
          const { clock, auth, tokens, activations } = buildHarness();

          // 1. Выпуск токена в момент issueMs.
          clock.setMs(issueMs);
          const token = await tokens.issue('user-1');

          if (useFirst) {
            // Успешное первое использование в пределах срока действия (elapsed 0).
            clock.setMs(issueMs);
            const firstOk = await trySetPassword(auth, token);
            expect(firstOk).toBe(true);

            // Повторная попытка в момент issueMs + elapsed: всегда отклоняется,
            // т.к. одноразовый токен уже использован (Req 5.6, 15.3, 19.6).
            clock.setMs(issueMs + elapsedSeconds * 1000);
            const secondOk = await trySetPassword(auth, token);
            expect(secondOk).toBe(false);
            // Активация засчитана ровно один раз — за первое успешное использование.
            expect(activations).toEqual(['user-1']);
          } else {
            // Единственная попытка в момент issueMs + elapsed.
            clock.setMs(issueMs + elapsedSeconds * 1000);
            const ok = await trySetPassword(auth, token);
            // Валидность строго эквивалентна неистёкшему сроку (Req 15.2, 19.5, 19.7).
            const expectedValid = elapsedSeconds <= TTL_SECONDS;
            expect(ok).toBe(expectedValid);
            expect(activations).toEqual(expectedValid ? ['user-1'] : []);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('одноразовость: повторное потребление токена возвращает null в пределах срока', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        // Второе потребление — также в пределах TTL, чтобы изолировать
        // одноразовость от истечения срока.
        fc.integer({ min: 0, max: TTL_SECONDS }),
        async (issueMs, secondElapsed) => {
          const { clock, tokens } = buildHarness();
          clock.setMs(issueMs);
          const token = await tokens.issue('user-1');

          // Первое потребление в пределах срока — успех.
          await expect(tokens.consume(token)).resolves.toBe('user-1');

          // Второе потребление (даже в пределах срока) — отказ (Req 19.6).
          clock.setMs(issueMs + secondElapsed * 1000);
          await expect(tokens.consume(token)).resolves.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});
