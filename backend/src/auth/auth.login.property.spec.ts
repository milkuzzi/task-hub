import fc from 'fast-check';
import { Role, User } from '@prisma/client';
import { AuthenticationException } from '../common/errors';
import { AppConfigService } from '../config';
import { MailerService } from '../mailer';
import { UserRepository } from '../repositories';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PasswordSetupTokenService } from './password-setup-token.service';
import { SessionTokenService } from './session-token.service';
import { ClockService } from '../clock';
import { SessionRegistry } from '../infra';
import { SessionDisconnector } from './session-disconnector';
import { MaxOAuthPort } from '../max/oauth';
import { AuthSession } from './auth.types';

/**
 * **Feature: task-assignment-system, Property 15: Аутентификация по email и паролю**
 *
 * Property 15 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 5.7, 5.8**:
 *
 * Для любой комбинации email/пароль: сессия выдаётся тогда и только тогда,
 * когда комбинация верна, учётная запись активирована и не заблокирована; при
 * неверной комбинации вход отклоняется, данные не меняются, а сообщение об
 * ошибке не указывает, какое именно поле некорректно.
 *
 * Тест реализует ровно это одно свойство. Все внешние границы
 * ({@link UserRepository}, {@link PasswordService}, {@link SessionTokenService})
 * подменяются мок-объектами — обращений к реальным БД/Redis/SendPulse нет.
 * Минимум 100 итераций на fast-check (здесь — 300).
 *
 * Модель проверяемого инварианта (по реализации {@link AuthService.login}):
 * - аккаунт найден ⇔ введённый email совпадает с сохранённым (иначе единый
 *   ответ «неверная комбинация», Req 5.8);
 * - действующая блокировка отклоняет вход прежде проверки пароля отдельным
 *   сообщением о временной блокировке (Req 5.10) — это не раскрытие поля;
 * - сессия выдаётся ⇔ email верный И пароль верный И учётная запись
 *   активирована И не заблокирована (Req 5.7);
 * - при неверной комбинации сохранённые учётные данные (email, хеш пароля) не
 *   изменяются, а сообщение об ошибке едино и не указывает поле (Req 5.8).
 */
describe('Property 15: Аутентификация по email и паролю (Req 5.7, 5.8)', () => {
  const STORED_EMAIL = 'user@example.com';
  const CORRECT_PASSWORD = 'correct-password';
  const STORED_HASH = 'stored-correct-hash';
  const NOW = new Date('2024-06-01T12:00:00.000Z');

  /**
   * Создаёт окружение сервиса со stateful-моками вокруг единственной учётной
   * записи. Учётная запись моделируется изменяемым объектом, чтобы наблюдать,
   * меняются ли сохранённые учётные данные при отклонённом входе.
   *
   * @param isActive Активирована ли учётная запись.
   * @param locked Действует ли блокировка на момент {@link NOW}.
   */
  const makeEnv = (isActive: boolean, locked: boolean) => {
    const account = {
      id: 'user-1',
      email: STORED_EMAIL,
      displayName: STORED_EMAIL,
      role: Role.EXECUTOR as Role,
      isActive,
      passwordHash: STORED_HASH as string | null,
      deletedAt: null as Date | null,
      failedLoginCount: 0,
      // Блокировка в будущем относительно NOW ⇒ действует; иначе снята.
      lockedUntil: locked ? new Date(NOW.getTime() + 10 * 60 * 1000) : null,
    };

    // findActiveByEmail возвращает не удалённую запись по точному совпадению
    // адреса (реализация фильтрует только deletedAt, активность проверяет сам
    // login). Несовпадение адреса ⇒ null (аккаунт «не найден»).
    const findActiveByEmail = jest.fn(async (email: string) =>
      email === STORED_EMAIL ? (account as unknown as User) : null,
    );
    const update = jest.fn(async (_id: string, patch: Partial<typeof account>) => {
      Object.assign(account, patch);
      return account as unknown as User;
    });

    const repository = {
      findActiveByEmail,
      update,
    } as unknown as UserRepository;

    const passwords = {
      // Пароль верен ⇔ совпадает с эталонным открытым паролем.
      verify: jest.fn(
        async (plain: string, hash: string) => hash === STORED_HASH && plain === CORRECT_PASSWORD,
      ),
      hash: jest.fn(),
    } as unknown as PasswordService;

    const issuedSession: AuthSession = {
      accessToken: 'signed-jwt',
      tokenId: 'token-1',
      userId: account.id,
      role: account.role,
      expiresAt: new Date(NOW.getTime() + 3600 * 1000),
    };
    const issue = jest.fn().mockResolvedValue(issuedSession);
    const sessionTokens = { issue } as unknown as SessionTokenService;

    const config = {
      app: { publicUrl: 'https://app.example.com/' },
      limits: {
        loginMaxFailedAttempts: 5,
        loginLockoutSeconds: 15 * 60,
      },
    } as unknown as AppConfigService;

    const service = new AuthService(
      repository,
      passwords,
      { issue: jest.fn(), consume: jest.fn() } as unknown as PasswordSetupTokenService,
      { enqueue: jest.fn() } as unknown as MailerService,
      config,
      sessionTokens,
      { now: jest.fn(() => NOW) } as unknown as ClockService,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode: jest.fn() } as unknown as MaxOAuthPort,
    );

    return { service, account, issue, issuedSession };
  };

  it('сессия выдаётся ⇔ верная комбинация, активна и не заблокирована; иначе отказ без раскрытия поля', async () => {
    // Накапливаем сообщения отказа «неверная комбинация» по всем итерациям:
    // если поле не раскрывается, сообщение должно быть единым (Req 5.8).
    const invalidComboMessages = new Set<string>();

    await fc.assert(
      fc.asyncProperty(
        // Введённый email: либо сохранённый (верный), либо произвольный иной.
        fc.oneof(
          fc.constant(STORED_EMAIL),
          fc.string().filter((s) => s !== STORED_EMAIL),
        ),
        // Введённый пароль: либо верный, либо произвольный иной.
        fc.oneof(
          fc.constant(CORRECT_PASSWORD),
          fc.string().filter((s) => s !== CORRECT_PASSWORD),
        ),
        fc.boolean(), // isActive
        fc.boolean(), // locked
        async (inputEmail, inputPassword, isActive, locked) => {
          const { service, account, issue, issuedSession } = makeEnv(isActive, locked);

          const emailCorrect = inputEmail === STORED_EMAIL;
          const passwordCorrect = inputPassword === CORRECT_PASSWORD;

          // Эталон: сессия — тогда и только тогда, когда всё верно (Req 5.7).
          const expectSession = emailCorrect && passwordCorrect && isActive && !locked;
          // Временная блокировка отклоняет вход прежде проверки пароля и
          // отдельным сообщением (Req 5.10) — применима только к найденному и
          // заблокированному аккаунту.
          const expectLockMessage = emailCorrect && locked;

          if (expectSession) {
            const session = await service.login(inputEmail, inputPassword, '203.0.113.7');
            expect(session).toEqual(issuedSession);
            expect(issue).toHaveBeenCalledTimes(1);
            // Учётные данные остаются неизменными.
            expect(account.email).toBe(STORED_EMAIL);
            expect(account.passwordHash).toBe(STORED_HASH);
          } else {
            await expect(
              service.login(inputEmail, inputPassword, '203.0.113.7'),
            ).rejects.toBeInstanceOf(AuthenticationException);

            // Повторяем вызов, чтобы получить сообщение исключения детерминированно.
            let message = '';
            try {
              await service.login(inputEmail, inputPassword, '203.0.113.7');
            } catch (err) {
              message = (err as AuthenticationException).message;
            }

            // Сессия не выдаётся ни при каком отказе.
            expect(issue).not.toHaveBeenCalled();
            // Сохранённые учётные данные (email, хеш пароля) не меняются (Req 5.8).
            expect(account.email).toBe(STORED_EMAIL);
            expect(account.passwordHash).toBe(STORED_HASH);

            if (expectLockMessage) {
              // Сообщение о временной блокировке — отдельный класс ответа.
              expect(message).toContain('заблокирована');
            } else {
              // Единое сообщение «неверная комбинация» не указывает поле:
              // оно перечисляет оба поля как альтернативу и не называет
              // конкретное некорректное.
              invalidComboMessages.add(message);
              expect(message).toContain('или');
              expect(message).not.toMatch(/некорректн\w*\s+(адрес|email|пароль)/i);
            }
          }
        },
      ),
      { numRuns: 300 },
    );

    // Сообщение «неверная комбинация» едино для всех некорректных входов —
    // оно не может зависеть от того, какое поле неверно (Req 5.8).
    expect(invalidComboMessages.size).toBeLessThanOrEqual(1);
  });
});
