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
import { MaxOAuthExchangeError, MaxOAuthPort } from '../max/oauth';
import { AuthSession } from './auth.types';

/**
 * **Feature: task-assignment-system, Property 44: Вход через OAuth MAX**
 *
 * Property 44 (см. design.md «Correctness Properties») —
 * **Validates: Requirements 5.11, 16.1, 16.2, 16.3**:
 *
 * Для любого результата OAuth MAX: Сессия выдаётся тогда и только тогда, когда
 * обмен кода авторизации на стороне MAX успешен И полученный `maxUserId`
 * привязан к активной (не удалённой и активированной) учётной записи; иначе
 * (ошибка обмена, отсутствие привязки, удалённый/неактивный пользователь) вход
 * отклоняется {@link AuthenticationException}, Пользователь остаётся
 * неаутентифицированным, и НИ одна учётная запись или привязка не создаётся
 * (привязка MAX не заменяет регистрацию Администратором).
 *
 * Тест реализует ровно одно это свойство. Все внешние границы
 * ({@link MaxOAuthPort}, {@link UserRepository}, {@link SessionTokenService})
 * подменяются мок-объектами — обращений к реальному сервису MAX/БД/Redis нет.
 * Минимум 100 итераций fast-check (здесь — 300).
 *
 * Модель проверяемого инварианта (по реализации {@link AuthService.loginWithMax}):
 * - обмен `authCode → maxUserId` через {@link MaxOAuthPort.exchangeAuthCode};
 *   любое исключение обмена ⇒ отказ во входе (Req 16.3);
 * - {@link UserRepository.findActiveUserByMaxUserId} возвращает запись только
 *   для активного привязанного пользователя; `null` для отсутствия привязки и
 *   для удалённых/неактивных учётных записей;
 * - Сессия выдаётся ⇔ обмен успешен И найден активный привязанный пользователь
 *   (Req 16.1);
 * - во всех прочих случаях — {@link AuthenticationException}, выпуск Сессии не
 *   вызывается, и операции создания/изменения учётной записи не выполняются
 *   (Req 5.11, 16.2, 16.3).
 */
describe('Property 44: Вход через OAuth MAX (Req 5.11, 16.1, 16.2, 16.3)', () => {
  const NOW = new Date('2024-06-01T12:00:00.000Z');
  const LINKED_MAX_USER_ID = 'max-linked';

  const linkedAccount = {
    id: 'user-linked',
    email: 'linked@example.com',
    displayName: 'linked@example.com',
    role: Role.EXECUTOR as Role,
    isActive: true,
    passwordHash: 'stored-hash' as string | null,
    deletedAt: null as Date | null,
    failedLoginCount: 0,
    lockedUntil: null as Date | null,
  };

  /**
   * Создаёт окружение сервиса со stateful-моками вокруг порта OAuth MAX и
   * репозитория. Репозиторий возвращает активную учётную запись только для
   * `LINKED_MAX_USER_ID`, моделируя, что для удалённых/неактивных/непривязанных
   * профилей запись недоступна.
   *
   * @param exchangeSucceeds Успешен ли обмен кода авторизации на стороне MAX.
   * @param exchangedMaxUserId Идентификатор профиля MAX при успешном обмене.
   */
  const makeEnv = (exchangeSucceeds: boolean, exchangedMaxUserId: string) => {
    const exchangeAuthCode = jest.fn(async () => {
      if (!exchangeSucceeds) {
        throw new MaxOAuthExchangeError('MAX отклонил авторизацию');
      }
      return exchangedMaxUserId;
    });

    const findActiveUserByMaxUserId = jest.fn(async (maxUserId: string) =>
      maxUserId === LINKED_MAX_USER_ID ? ({ ...linkedAccount } as unknown as User) : null,
    );
    const create = jest.fn();
    const update = jest.fn();

    const repository = {
      findActiveUserByMaxUserId,
      create,
      update,
    } as unknown as UserRepository;

    const issuedSession: AuthSession = {
      accessToken: 'signed-jwt',
      tokenId: 'token-1',
      userId: linkedAccount.id,
      role: linkedAccount.role,
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
      { hash: jest.fn(), verify: jest.fn() } as unknown as PasswordService,
      { issue: jest.fn(), consume: jest.fn() } as unknown as PasswordSetupTokenService,
      { enqueue: jest.fn() } as unknown as MailerService,
      config,
      sessionTokens,
      { now: jest.fn(() => NOW) } as unknown as ClockService,
      { revokeAllForUser: jest.fn(), isValid: jest.fn() } as unknown as SessionRegistry,
      { disconnectUser: jest.fn() } as unknown as SessionDisconnector,
      { exchangeAuthCode } as unknown as MaxOAuthPort,
    );

    return {
      service,
      exchangeAuthCode,
      findActiveUserByMaxUserId,
      create,
      update,
      issue,
      issuedSession,
    };
  };

  it('Сессия выдаётся ⇔ обмен успешен И профиль MAX привязан к активному пользователю; иначе отказ без создания записей', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Одноразовый код авторизации (любая непустая строка).
        fc.string({ minLength: 1, maxLength: 64 }),
        // Успешен ли обмен на стороне MAX.
        fc.boolean(),
        // Идентификатор профиля MAX при успешном обмене: либо привязанный, либо
        // произвольный непривязанный/неактивный (моделируется отсутствием записи).
        fc.oneof(
          fc.constant(LINKED_MAX_USER_ID),
          fc.string({ maxLength: 32 }).filter((s) => s !== LINKED_MAX_USER_ID),
        ),
        async (authCode, exchangeSucceeds, exchangedMaxUserId) => {
          const {
            service,
            exchangeAuthCode,
            findActiveUserByMaxUserId,
            create,
            update,
            issue,
            issuedSession,
          } = makeEnv(exchangeSucceeds, exchangedMaxUserId);

          // Эталон: Сессия выдаётся только при успешном обмене и привязке к
          // активному пользователю (Req 16.1).
          const expectSession = exchangeSucceeds && exchangedMaxUserId === LINKED_MAX_USER_ID;

          if (expectSession) {
            const session = await service.loginWithMax(authCode);

            expect(session).toEqual(issuedSession);
            expect(exchangeAuthCode).toHaveBeenCalledWith(authCode);
            expect(findActiveUserByMaxUserId).toHaveBeenCalledWith(exchangedMaxUserId);
            expect(issue).toHaveBeenCalledTimes(1);
          } else {
            await expect(service.loginWithMax(authCode)).rejects.toBeInstanceOf(
              AuthenticationException,
            );

            // Пользователь остаётся неаутентифицированным: Сессия не выдаётся.
            expect(issue).not.toHaveBeenCalled();
            if (!exchangeSucceeds) {
              // При ошибке обмена привязка даже не запрашивается (Req 16.3).
              expect(findActiveUserByMaxUserId).not.toHaveBeenCalled();
            }
          }

          // Во всех случаях вход через MAX не создаёт учётных записей/привязок и
          // не изменяет существующие — привязка MAX не заменяет регистрацию
          // Администратором (Req 5.11, 16.2).
          expect(create).not.toHaveBeenCalled();
          expect(update).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 300 },
    );
  });
});
