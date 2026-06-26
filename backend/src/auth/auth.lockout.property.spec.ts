import fc from 'fast-check';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { ClockService } from '../clock';
import { MailerService } from '../mailer';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { SessionRegistry } from '../infra';
import { SessionDisconnector } from './session-disconnector';
import { MaxOAuthPort } from '../max/oauth';
import { AuthSession } from './auth.types';

/**
 * **Feature: task-assignment-system, Property 14: Блокировка после неудачных попыток входа**
 *
 * Property 14 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 5.9, 5.10, 19.3, 19.4**:
 *
 * Для любой последовательности попыток входа, при достижении 5 последовательных
 * неудач вход в учётную запись блокируется на 15 минут, и пока блокировка
 * активна любая попытка входа (даже с верными данными) отклоняется с сообщением
 * о временной блокировке.
 *
 * Тест реализует ровно это одно свойство. Все внешние границы
 * ({@link UserRepository}, {@link PasswordService},
 * {@link SessionTokenService}) подменяются мок-объектами, а текущее время
 * управляется через инъецируемый {@link ClockService} — обращений к реальным
 * БД/Redis/SendPulse нет. Минимум 100 итераций на fast-check (здесь — 200).
 *
 * Проверяемые инварианты (по реализации {@link AuthService.login}):
 * - после 5 последовательных неудач `lockedUntil` устанавливается ровно на
 *   15 минут (900 с) вперёд от момента 5-й неудачи (Req 5.9, 19.3);
 * - пока блокировка активна, любая попытка входа — в том числе с верным
 *   паролем — отклоняется {@link AuthenticationException} с сообщением о
 *   временной блокировке, при этом сессия не выпускается и пароль даже не
 *   проверяется (Req 5.10, 19.4).
 */
describe('Property 14: Блокировка после неудачных попыток входа (Req 5.9, 5.10, 19.3, 19.4)', () => {
  const CORRECT_PASSWORD = 'correct-password';
  const WRONG_PASSWORD = 'wrong-password';
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_MS = 900_000; // 15 минут
  const BASE_MS = Date.UTC(2024, 0, 1, 0, 0, 0);

  const issuedSession: AuthSession = {
    accessToken: 'signed.jwt.token',
    tokenId: 'token-id',
    userId: 'user-1',
    role: Role.EXECUTOR,
    expiresAt: new Date(BASE_MS + LOCKOUT_MS),
  };

  /**
   * Создаёт окружение сервиса с управляемым временем и stateful-моками.
   * Учётная запись активна и имеет пароль; `verify` считает пароль верным
   * тогда и только тогда, когда он равен {@link CORRECT_PASSWORD}.
   */
  const makeEnv = () => {
    let currentMs = BASE_MS;

    const account = {
      id: 'user-1',
      email: 'user@example.com',
      role: Role.EXECUTOR as Role,
      isActive: true,
      passwordHash: 'stored-hash',
      deletedAt: null as Date | null,
      failedLoginCount: 0,
      lockedUntil: null as Date | null,
    };

    const findActiveByEmail = jest.fn(async () => account as unknown as User);
    const update = jest.fn(async (_id: string, patch: Partial<typeof account>) => {
      Object.assign(account, patch);
      return account as unknown as User;
    });
    const verify = jest.fn(async (plain: string) => plain === CORRECT_PASSWORD);
    const issueSession = jest.fn(async () => issuedSession);
    const nowMock = jest.fn(() => new Date(currentMs));

    const repository = {
      findActiveByEmail,
      update,
    } as unknown as UserRepository;
    const passwords = { verify } as unknown as PasswordService;
    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      limits: {
        passwordMinLength: 8,
        passwordMaxLength: 128,
        passwordSetupTtlSeconds: 86400,
        loginMaxFailedAttempts: MAX_FAILED_ATTEMPTS,
        loginLockoutSeconds: LOCKOUT_MS / 1000,
      },
    } as unknown as AppConfigService;
    const sessionTokens = { issue: issueSession } as unknown as SessionTokenService;
    const clock = { now: nowMock } as unknown as ClockService;

    const service = new AuthService(
      repository,
      passwords,
      {} as unknown as PasswordSetupTokenService,
      {} as unknown as MailerService,
      config,
      sessionTokens,
      clock,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );

    return {
      service,
      account,
      verify,
      issueSession,
      advance: (ms: number) => {
        currentMs += ms;
      },
      now: () => currentMs,
    };
  };

  /**
   * Генератор одной попытки входа: верный/неверный пароль и приращение времени
   * до попытки. Малые приращения (0–120 с) преобладают, чтобы блокировка
   * успевала наступить и сохраняться; крупные (до ~33 мин) изредка позволяют
   * блокировке истечь — это покрывает обе области входного пространства.
   */
  const attemptArb = fc.record({
    correct: fc.boolean(),
    advanceMs: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 120_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 120_001, max: 2_000_000 }) },
    ),
  });

  type Attempt = { correct: boolean; advanceMs: number };

  it('5 последовательных неудач → блокировка на 15 мин; во время блокировки любой вход отклонён', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(attemptArb, { minLength: 1, maxLength: 30 }),
        async (attempts: Attempt[]) => {
          const env = makeEnv();

          // Эталонная модель состояния блокировки, повторяющая логику
          // AuthService.login / registerFailedAttempt.
          let modelFailed = 0;
          let modelLockedUntil: number | null = null;

          for (const attempt of attempts) {
            env.advance(attempt.advanceMs);
            const t = env.now();

            const wasLocked = modelLockedUntil !== null && modelLockedUntil > t;
            const issueCallsBefore = env.issueSession.mock.calls.length;
            const verifyCallsBefore = env.verify.mock.calls.length;

            if (wasLocked) {
              // Пока блокировка активна — отклоняем даже верный пароль (Req 5.10, 19.4).
              const error = await env.service
                .login(
                  'user@example.com',
                  attempt.correct ? CORRECT_PASSWORD : WRONG_PASSWORD,
                  '127.0.0.1',
                )
                .catch((e) => e);

              expect(error).toBeInstanceOf(AuthenticationException);
              expect(error.message).toContain('временно заблокирована');
              // Сессия не выпущена и пароль даже не проверялся.
              expect(env.issueSession.mock.calls.length).toBe(issueCallsBefore);
              expect(env.verify.mock.calls.length).toBe(verifyCallsBefore);
              // Состояние блокировки модели не меняется.
            } else if (attempt.correct) {
              // Верный пароль вне блокировки — успешный вход, счётчик сброшен.
              const result = await env.service.login(
                'user@example.com',
                CORRECT_PASSWORD,
                '127.0.0.1',
              );
              expect(result).toBe(issuedSession);
              expect(env.account.failedLoginCount).toBe(0);
              expect(env.account.lockedUntil).toBeNull();

              modelFailed = 0;
              modelLockedUntil = null;
            } else {
              // Неверный пароль вне блокировки — учитываем неудачу.
              const error = await env.service
                .login('user@example.com', WRONG_PASSWORD, '127.0.0.1')
                .catch((e) => e);
              expect(error).toBeInstanceOf(AuthenticationException);
              expect(error.message).toBe('Неверный адрес электронной почты или пароль.');

              const lockExpired = modelLockedUntil !== null && modelLockedUntil <= t;
              const base = lockExpired ? 0 : modelFailed;
              modelFailed = base + 1;

              if (modelFailed >= MAX_FAILED_ATTEMPTS) {
                // Достигнут порог: блокировка ровно на 15 минут (Req 5.9, 19.3).
                modelLockedUntil = t + LOCKOUT_MS;
                expect(env.account.lockedUntil).not.toBeNull();
                expect((env.account.lockedUntil as Date).getTime()).toBe(t + LOCKOUT_MS);
              } else {
                modelLockedUntil = null;
                expect(env.account.lockedUntil).toBeNull();
              }
              expect(env.account.failedLoginCount).toBe(modelFailed);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
